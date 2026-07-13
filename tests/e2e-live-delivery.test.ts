// tests/e2e-live-delivery.test.ts
//
// End-to-end live-simulation test for the round-2 delivery bugs the user
// reported: (a) tab title reverting to "node", (b) peers not receiving
// messages when the receiver was idle at the prompt.
//
// Strategy: spawn a real broker subprocess, then drive the broker HTTP
// API from test code the same way a live `claude-server` poll loop
// would — register two peers, send messages between them, poll +
// confirm delivery semantics. This covers the broker half of the
// message-delivery path end-to-end against a real SQLite + HTTP daemon.
//
// (The last mile — "Claude Code renders the channel push to the user"
// and "Codex CLI surfaces the [PEER INBOX] block to the model" — can
// only be verified manually in a real terminal, because neither client
// exposes a test harness we can drive. But the broker-side semantics
// are fully covered here, which is what the reported bugs hinge on.)

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker.ts";
import { createClient } from "../shared/broker-client.ts";
import { CodexInboxStore as DurableInboxStore } from "../shared/codex-inbox.ts";
import { formatInboxBlock } from "../shared/piggyback.ts";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = "/tmp/agent-peers-e2e-live-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-e2e-live-secret-" + Date.now();
const TEST_PORT = 7921;
let handle: ReturnType<typeof startBroker>;
let testSecret: string;
const stateDirs: string[] = [];

async function durableStore(peerId: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "agent-peers-e2e-inbox-"));
  stateDirs.push(rootDir);
  const store = new DurableInboxStore({ peerId, rootDir });
  await store.init();
  return { store, rootDir };
}

beforeAll(() => {
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
  testSecret = readFileSync(TEST_SECRET, "utf8").trim();
});
afterAll(async () => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  for (const p of [TEST_DB, TEST_SECRET]) if (existsSync(p)) unlinkSync(p);
  await Promise.all(stateDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("live broker flow: sender → broker → receiver-poll returns the message with sender identity intact", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const sender = await client.register({
    peer_type: "claude", pid: 1001, cwd: "/projA", git_root: null,
    tty: null, summary: "working on auth refactor", name: "claude-sender",
  });
  const receiver = await client.register({
    peer_type: "codex", pid: 1002, cwd: "/projB", git_root: null,
    tty: null, summary: "", name: "codex-receiver",
  });

  const sent = await client.sendMessage({
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: "codex-receiver",
    text: "B is on bcrypt 5, we bake tenant_id into JWTs",
  });
  expect(sent.ok).toBe(true);

  const polled = await client.pollMessages({
    id: receiver.id, session_token: receiver.session_token,
  });
  expect(polled.length).toBe(1);
  expect(polled[0]!.from_name).toBe("claude-sender");
  expect(polled[0]!.from_peer_type).toBe("claude");
  expect(polled[0]!.from_summary).toBe("working on auth refactor");
  expect(polled[0]!.text).toContain("bcrypt 5");
});

test("idle-arrival persists durably before broker acknowledgement", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const sender = await client.register({
    peer_type: "claude", pid: 2001, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "idle-sender",
  });
  const idleReceiver = await client.register({
    peer_type: "claude", pid: 2002, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "idle-receiver",
  });
  const body = "did you see the auth change in PR #42?";
  expect((await client.sendMessage({
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: idleReceiver.id, text: body,
  })).ok).toBe(true);
  const polled = await client.pollMessages({ id: idleReceiver.id, session_token: idleReceiver.session_token });
  const { store, rootDir } = await durableStore("claude-idle-receiver");
  await store.queueLeasedMessages(polled);
  expect((await client.ackMessages({
    id: idleReceiver.id, session_token: idleReceiver.session_token,
    lease_tokens: polled.map((m) => m.lease_token),
  })).acked).toBe(1);

  // A fresh process can recover the body even though the broker row is acked.
  const restarted = new DurableInboxStore({ peerId: "claude-idle-receiver", rootDir });
  await restarted.init();
  const recent = await restarted.getUnreadMessages();
  expect(recent.map((m) => m.text)).toEqual([body]);
  expect(formatInboxBlock(recent)).toContain('"from_name":"idle-sender"');
});

test("multiple idle arrivals persist and confirm selectively", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const sender = await client.register({
    peer_type: "claude", pid: 3001, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "multi-sender",
  });
  const receiver = await client.register({
    peer_type: "claude", pid: 3002, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "multi-receiver",
  });
  for (const text of ["question one", "question two", "question three"]) {
    expect((await client.sendMessage({
      from_id: sender.id, session_token: sender.session_token,
      to_id_or_name: receiver.id, text,
    })).ok).toBe(true);
  }
  const polled = await client.pollMessages({ id: receiver.id, session_token: receiver.session_token });
  const { store } = await durableStore("claude-multi-receiver");
  await store.queueLeasedMessages(polled);
  await store.removeByIds([polled[0]!.id]);
  expect((await store.getUnreadMessages()).map((m) => m.text)).toEqual(["question two", "question three"]);
});

test("reclaim-safe backlog: peer dies mid-lease, restarts with same name, backlog surfaces on first poll", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const sender = await client.register({
    peer_type: "claude", pid: 4001, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "reclaim-sender",
  });
  const victim = await client.register({
    peer_type: "codex", pid: 4002, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "doomed-receiver",
  });

  // Sender queues a message while victim is up.
  await client.sendMessage({
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "doomed-receiver", text: "important-before-crash",
  });

  // Victim polls — message leased to victim (30s lease).
  const leased = await client.pollMessages({
    id: victim.id, session_token: victim.session_token,
  });
  expect(leased.length).toBe(1);

  // Victim "dies" mid-lease (does NOT ack). Simulate by marking last_seen
  // stale via the DB directly. In production this happens when the peer's
  // process dies + heartbeats stop for 60+ seconds.
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", victim.id);

  // New session reclaims the name.
  const reclaimed = await client.register({
    peer_type: "codex", pid: 4003, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "doomed-receiver", reclaim_token: victim.reclaim_token,
  });
  expect(reclaimed.id).toBe(victim.id); // same UUID
  expect(reclaimed.session_token).not.toBe(victim.session_token); // rotated

  // First poll from the reclaimed session MUST see the backlog
  // immediately — not 30s later when the old lease expires. This is
  // the reclaim-clears-leases fix in broker.ts:registerPeer.
  const backlog = await client.pollMessages({
    id: reclaimed.id, session_token: reclaimed.session_token,
  });
  expect(backlog.length).toBe(1);
  expect(backlog[0]!.text).toBe("important-before-crash");
});
