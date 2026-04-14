// End-to-end test: real broker process serving a real HTTP client.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker.ts";
import { createClient } from "../shared/broker-client.ts";
import { readFileSync, unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-e2e-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-e2e-secret-" + Date.now();
const TEST_PORT = 7911;
let handle: ReturnType<typeof startBroker>;
let testSecret: string;

beforeAll(() => {
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
  testSecret = readFileSync(TEST_SECRET, "utf8").trim();
});
afterAll(() => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  for (const p of [TEST_DB, TEST_SECRET]) if (existsSync(p)) unlinkSync(p);
});

test("broker-client end-to-end: register → send → poll → ack", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const a = await client.register({
    peer_type: "claude", pid: 10, cwd: "/a", git_root: null, tty: null, summary: "",
    name: "alpha",
  });
  const b = await client.register({
    peer_type: "codex", pid: 11, cwd: "/a", git_root: null, tty: null, summary: "",
    name: "beta",
  });
  expect(a.name).toBe("alpha");
  expect(b.name).toBe("beta");
  expect(a.session_token).toBeTruthy();

  const sent = await client.sendMessage({
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "hi",
  });
  expect(sent.ok).toBe(true);

  const polled = await client.pollMessages({ id: b.id, session_token: b.session_token });
  expect(polled.length).toBe(1);
  expect(polled[0]!.from_name).toBe("alpha");

  const acked = await client.ackMessages({
    id: b.id, session_token: b.session_token,
    lease_tokens: polled.map((m) => m.lease_token),
  });
  expect(acked.acked).toBe(1);
});

test("broker-client self-rename with peer session token", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const p = await client.register({
    peer_type: "claude", pid: 20, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "renamer",
  });
  const r = await client.renamePeer({
    id: p.id, session_token: p.session_token, new_name: "renamed",
  });
  expect(r.ok).toBe(true);
  expect(r.name).toBe("renamed");
});

test("broker-client rejects peer-rename with wrong token (auth)", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const p = await client.register({
    peer_type: "claude", pid: 22, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "locked",
  });
  const r = await client.renamePeer({
    id: p.id, session_token: "wrong-token", new_name: "hacked",
  });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/unauthorized/i);
});

test("broker-client isAlive returns true for live broker, false for wrong port", async () => {
  const live = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const dead = createClient(`http://127.0.0.1:9999`, testSecret);
  expect(await live.isAlive()).toBe(true);
  expect(await dead.isAlive()).toBe(false);
});

test("broker rejects HTTP requests without the shared-secret header (auth regression)", async () => {
  // Codex round-C: mere localhost binding is NOT a trust boundary on
  // shared/multi-user hosts. Broker must require the X-Agent-Peers-Secret
  // header (from ~/.agent-peers-secret with mode 0600) on every non-/health
  // request. Verify a 401-class rejection when the header is wrong.
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "machine", cwd: "/any", git_root: null }),
  });
  expect(res.status).toBe(401);
});
