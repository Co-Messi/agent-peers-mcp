// End-to-end test: real broker process serving a real HTTP client.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker.ts";
import { createClient } from "../shared/broker-client.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-e2e-" + Date.now() + ".db";
const TEST_PORT = 7911;
let handle: ReturnType<typeof startBroker>;

beforeAll(() => {
  handle = startBroker(TEST_PORT, TEST_DB);
});
afterAll(() => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

test("broker-client end-to-end: register → send → poll → ack", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);

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
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);

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

test("broker-client admin-rename (no session token)", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);

  const p = await client.register({
    peer_type: "claude", pid: 21, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "admin-target",
  });
  const r = await client.adminRenamePeer({ id: p.id, new_name: "admin-renamed" });
  expect(r.ok).toBe(true);
  expect(r.name).toBe("admin-renamed");
});

test("broker-client rejects peer-rename with wrong token (auth)", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);

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
  const live = createClient(`http://127.0.0.1:${TEST_PORT}`);
  const dead = createClient(`http://127.0.0.1:9999`);
  expect(await live.isAlive()).toBe(true);
  expect(await dead.isAlive()).toBe(false);
});
