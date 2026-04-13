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

  const sent = await client.sendMessage({
    from_id: a.id, to_id_or_name: "beta", text: "hi",
  });
  expect(sent.ok).toBe(true);

  const polled = await client.pollMessages(b.id);
  expect(polled.length).toBe(1);
  expect(polled[0]!.from_name).toBe("alpha");

  const acked = await client.ackMessages({
    id: b.id, lease_tokens: polled.map((m) => m.lease_token),
  });
  expect(acked.acked).toBe(1);
});

test("broker-client rename_peer + list_peers round-trip", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);

  const p = await client.register({
    peer_type: "claude", pid: 20, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "renamer",
  });
  const r = await client.renamePeer({ id: p.id, new_name: "renamed" });
  expect(r.ok).toBe(true);
  expect(r.name).toBe("renamed");

  const peers = await client.listPeers({
    scope: "machine", cwd: "/", git_root: null,
  });
  expect(peers.some((q) => q.id === p.id && q.name === "renamed")).toBe(true);
});

test("broker-client isAlive returns true for a live broker", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);
  expect(await client.isAlive()).toBe(true);
});

test("broker-client isAlive returns false for a wrong port", async () => {
  const client = createClient(`http://127.0.0.1:9999`);
  expect(await client.isAlive()).toBe(false);
});
