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
import {
  recordDelivered,
  getRecentDelivered,
  __resetRecentDeliveredForTest,
} from "../shared/recent-delivered.ts";
import { formatInboxBlock } from "../shared/piggyback.ts";
import { readFileSync, unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-e2e-live-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-e2e-live-secret-" + Date.now();
const TEST_PORT = 7921;
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

test("idle-arrival simulation for Claude's check_messages backfill path", async () => {
  // This is the exact scenario from the user's live report:
  //   1. Receiver's session is up and has an MCP background poll loop
  //      running (simulated here by the explicit pollMessages call).
  //   2. Sender sends a message while receiver is idle at the prompt.
  //   3. The poll loop picks up the message and would push via
  //      `notifications/claude/channel` — but because the session is
  //      idle, Claude Code silently queues the push (does not surface
  //      to the model until the next user turn begins).
  //   4. We simulate the push-loop side effect on our in-memory ring
  //      buffer (which the real claude-server.ts populates inline with
  //      the channel-push notification call).
  //   5. Receiver broker-acks the message (push succeeded at transport
  //      level, broker forgets it).
  //   6. User later asks receiver "check messages". The broker would
  //      return nothing (message already acked), BUT the ring buffer
  //      still has it — so check_messages surfaces it as a [PEER INBOX]
  //      block. No silent loss.

  __resetRecentDeliveredForTest();
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const sender = await client.register({
    peer_type: "claude", pid: 2001, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "idle-sender",
  });
  const idleReceiver = await client.register({
    peer_type: "claude", pid: 2002, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "idle-receiver",
  });

  // Sender sends while receiver is "idle at prompt" (no active turn).
  const body = "did you see the auth change in PR #42?";
  const sent = await client.sendMessage({
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "idle-receiver", text: body,
  });
  expect(sent.ok).toBe(true);

  // Receiver's pollAndPush loop runs 1s later.
  const polled = await client.pollMessages({
    id: idleReceiver.id, session_token: idleReceiver.session_token,
  });
  expect(polled.length).toBe(1);

  // Simulate the push-loop side effect: mcp.notification() resolves (bytes
  // written to transport) → we record-delivered into the ring buffer + ack
  // the broker. Whether Claude Code renders the push to the model is
  // opaque to us at this point; the ring buffer is the fallback so we
  // don't care.
  const msg = polled[0]!;
  recordDelivered(msg);
  const acked = await client.ackMessages({
    id: idleReceiver.id, session_token: idleReceiver.session_token,
    lease_tokens: [msg.lease_token],
  });
  expect(acked.ok).toBe(true);
  expect(acked.acked).toBe(1);

  // Broker now has nothing more for idle-receiver — message is done.
  const emptyPoll = await client.pollMessages({
    id: idleReceiver.id, session_token: idleReceiver.session_token,
  });
  expect(emptyPoll).toEqual([]);

  // User later asks "check messages" → claude-server's check_messages
  // handler returns getRecentDelivered() formatted as a [PEER INBOX]
  // block. This is the critical property: the message is retrievable
  // even though the broker forgot about it.
  const recent = getRecentDelivered();
  expect(recent.length).toBe(1);
  expect(recent[0]!.text).toBe(body);
  expect(recent[0]!.from_name).toBe("idle-sender");

  const inbox = formatInboxBlock(recent);
  expect(inbox).toContain("PEER INBOX");
  expect(inbox).toContain("from: idle-sender");
  expect(inbox).toContain(body);
});

test("multiple idle-arrivals accumulate and all surface via check_messages backfill", async () => {
  __resetRecentDeliveredForTest();
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const sender = await client.register({
    peer_type: "claude", pid: 3001, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "multi-sender",
  });
  const receiver = await client.register({
    peer_type: "claude", pid: 3002, cwd: "/x", git_root: null, tty: null,
    summary: "", name: "multi-receiver",
  });

  // Three messages arrive while receiver is idle.
  for (const text of ["question one", "question two", "question three"]) {
    const r = await client.sendMessage({
      from_id: sender.id, session_token: sender.session_token,
      to_id_or_name: "multi-receiver", text,
    });
    expect(r.ok).toBe(true);
  }

  // Single poll drains all three.
  const polled = await client.pollMessages({
    id: receiver.id, session_token: receiver.session_token,
  });
  expect(polled.length).toBe(3);

  // Simulate push-loop recording each + acking batched.
  for (const m of polled) recordDelivered(m);
  await client.ackMessages({
    id: receiver.id, session_token: receiver.session_token,
    lease_tokens: polled.map((m) => m.lease_token),
  });

  // check_messages backfill surfaces all three.
  const recent = getRecentDelivered();
  expect(recent.length).toBe(3);
  expect(recent.map((m) => m.text)).toEqual([
    "question one", "question two", "question three",
  ]);

  const inbox = formatInboxBlock(recent);
  expect(inbox).toContain("3 unread message(s)");
  expect(inbox).toContain("question one");
  expect(inbox).toContain("question two");
  expect(inbox).toContain("question three");
});

test("reclaim-safe backlog: peer dies mid-lease, restarts with same name, backlog surfaces on first poll", async () => {
  __resetRecentDeliveredForTest();
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
    summary: "", name: "doomed-receiver",
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
