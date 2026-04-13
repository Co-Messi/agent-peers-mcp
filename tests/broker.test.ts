// Comprehensive unit tests for broker.ts — covers every in-process primitive.

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  registerPeer,
  heartbeatPeer,
  unregisterPeer,
  setPeerSummary,
  getPeer,
  getPeerByName,
  listPeers,
  sendMessage,
  pollMessages,
  ackMessages,
  renamePeer,
  gcStalePeers,
  listOrphanedMessages,
} from "../broker.ts";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

// Fresh DB per test. Bun runs tests concurrently in a single file but sequentially
// between files by default; using Date.now() + test name salt keeps them isolated.
let db: Database;
let TEST_DB: string;

beforeEach(() => {
  TEST_DB = `/tmp/agent-peers-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  db = initDb(TEST_DB);
});
afterEach(() => {
  db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

// ---------- schema ----------

test("initDb creates tables and indices with WAL", () => {
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r) => r.name);
  expect(tables).toContain("peers");
  expect(tables).toContain("messages");

  const indices = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
  ).all().map((r) => r.name);
  expect(indices).toContain("idx_messages_to_acked");
  expect(indices).toContain("idx_peers_last_seen");
  expect(indices).toContain("idx_peers_name");

  const pragma = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(pragma?.journal_mode.toLowerCase()).toBe("wal");
});

// ---------- peer CRUD ----------

test("registerPeer creates peer with UUID + name", () => {
  const { id, name } = registerPeer(db, {
    peer_type: "claude", pid: 1234, cwd: "/tmp", git_root: null, tty: null, summary: "",
  });
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(name.length).toBeGreaterThan(0);
  const peer = getPeer(db, id);
  expect(peer?.peer_type).toBe("claude");
  expect(peer?.name).toBe(name);
});

test("registerPeer honors explicit name if provided and unique", () => {
  const { id, name } = registerPeer(db, {
    peer_type: "codex", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "",
    name: "frontend-tab",
  });
  expect(name).toBe("frontend-tab");
  expect(getPeer(db, id)?.name).toBe("frontend-tab");
});

test("registerPeer appends -2 on name collision with live peer", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", name: "dup",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/a", git_root: null, tty: null, summary: "", name: "dup",
  });
  expect(a.name).toBe("dup");
  expect(b.name).toBe("dup-2");
});

test("registerPeer reclaims stale peer with same name, preserving UUID", () => {
  const first = registerPeer(db, {
    peer_type: "claude", pid: 111, cwd: "/original", git_root: null, tty: null,
    summary: "orig", name: "persistent",
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", first.id);
  const second = registerPeer(db, {
    peer_type: "claude", pid: 222, cwd: "/new-cwd", git_root: null, tty: null,
    summary: "new", name: "persistent",
  });
  expect(second.id).toBe(first.id);
  expect(second.name).toBe("persistent");
  const row = db.query<{ pid: number; cwd: string; summary: string }, [string]>(
    "SELECT pid, cwd, summary FROM peers WHERE id = ?"
  ).get(second.id)!;
  expect(row.pid).toBe(222);
  expect(row.cwd).toBe("/new-cwd");
  expect(row.summary).toBe("new");
});

test("registerPeer does NOT reclaim a LIVE peer, falls through to suffix", () => {
  const live = registerPeer(db, {
    peer_type: "claude", pid: 111, cwd: "/a", git_root: null, tty: null, summary: "",
    name: "active",
  });
  const second = registerPeer(db, {
    peer_type: "claude", pid: 222, cwd: "/b", git_root: null, tty: null, summary: "",
    name: "active",
  });
  expect(second.id).not.toBe(live.id);
  expect(second.name).toBe("active-2");
});

test("registerPeer is atomic under simulated interleaving", () => {
  // Simulate the race: insert a row under the broker's nose, then ask register
  // with the same name. Atomic INSERT must catch UNIQUE and advance.
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "external-id", "race", "claude", 99, "/ext", null, null, "",
    new Date().toISOString(), new Date().toISOString(),
  );
  const res = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", name: "race",
  });
  expect(res.name).toBe("race-2");
});

test("heartbeatPeer bumps last_seen", async () => {
  const { id } = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "",
  });
  const initial = getPeer(db, id)!.last_seen;
  await new Promise((r) => setTimeout(r, 20));
  heartbeatPeer(db, id);
  expect(getPeer(db, id)!.last_seen > initial).toBe(true);
});

test("setPeerSummary updates summary + last_seen", () => {
  const { id } = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "",
  });
  setPeerSummary(db, id, "Working on X");
  expect(getPeer(db, id)?.summary).toBe("Working on X");
});

test("unregisterPeer removes peer row, preserves messages", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", name: "a",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/a", git_root: null, tty: null, summary: "", name: "b",
  });
  sendMessage(db, { from_id: a.id, to_id_or_name: "b", text: "hi" });
  unregisterPeer(db, b.id);
  expect(getPeer(db, b.id)).toBeNull();
  // Message preserved
  const remaining = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ?"
  ).get(b.id);
  expect(remaining?.c).toBe(1);
});

// ---------- listPeers ----------

test("listPeers scope=machine returns all peers minus excluded", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: "/g", tty: null, summary: "",
  });
  const b = registerPeer(db, {
    peer_type: "codex", pid: 2, cwd: "/b", git_root: "/h", tty: null, summary: "",
  });
  const peers = listPeers(db, {
    scope: "machine", cwd: "/any", git_root: null, exclude_id: a.id,
  });
  expect(peers.map((p) => p.id)).toEqual([b.id]);
});

test("listPeers scope=directory filters by cwd", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "",
  });
  registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/y", git_root: null, tty: null, summary: "",
  });
  const peers = listPeers(db, {
    scope: "directory", cwd: "/x", git_root: null,
  });
  expect(peers.map((p) => p.id)).toEqual([a.id]);
});

test("listPeers scope=repo filters by git_root", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x/sub", git_root: "/x", tty: null, summary: "",
  });
  registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/y", git_root: "/y", tty: null, summary: "",
  });
  const peers = listPeers(db, { scope: "repo", cwd: "/x", git_root: "/x" });
  expect(peers.map((p) => p.id)).toEqual([a.id]);
});

test("listPeers peer_type filter", () => {
  registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "",
  });
  const c = registerPeer(db, {
    peer_type: "codex", pid: 2, cwd: "/a", git_root: null, tty: null, summary: "",
  });
  const peers = listPeers(db, {
    scope: "machine", cwd: "/any", git_root: null, peer_type: "codex",
  });
  expect(peers.map((p) => p.id)).toEqual([c.id]);
});

// ---------- sendMessage ----------

test("sendMessage by id stores message and returns ok+message_id", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: b.id, text: "hi" });
  expect(res.ok).toBe(true);
  expect(typeof res.message_id).toBe("number");
});

test("sendMessage by name resolves to id", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "hi" });
  expect(res.ok).toBe(true);
});

test("sendMessage unknown peer returns ok=false", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: "nobody", text: "hi" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unknown peer/i);
});

test("sendMessage with unknown from_id is rejected (identity validation)", () => {
  const b = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  const res = sendMessage(db, {
    from_id: "not-a-real-id", to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unknown sender/i);
});

test("sendMessage with stale from_id is rejected (identity validation)", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", a.id);
  const res = sendMessage(db, {
    from_id: a.id, to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/sender stale/i);
});

test("sendMessage to stale peer rejects", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", b.id);
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "hi" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/stale/i);
});

// ---------- pollMessages ----------

function mkPeers() {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  return { a, b };
}

test("pollMessages with unknown peer id returns empty (no queue drain)", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "secret" });
  // Stranger with a fake UUID should not see beta's inbox
  const stranger = pollMessages(db, "00000000-0000-0000-0000-000000000000");
  expect(stranger).toEqual([]);
  // Legitimate owner still can
  expect(pollMessages(db, b.id).length).toBe(1);
});

test("ackMessages with unknown peer id returns acked: 0 (no queue erase)", () => {
  const res = ackMessages(db, {
    id: "00000000-0000-0000-0000-000000000000",
    lease_tokens: ["anything"],
  });
  expect(res.acked).toBe(0);
});

test("pollMessages returns leased messages with enriched from fields", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "ping" });
  const out = pollMessages(db, b.id);
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("ping");
  expect(out[0]!.from_name).toBe("alpha");
  expect(out[0]!.from_peer_type).toBe("claude");
  expect(out[0]!.lease_token).toMatch(/^[a-f0-9-]{36}$/);
});

test("pollMessages twice does not re-deliver while lease active", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "once" });
  expect(pollMessages(db, b.id).length).toBe(1);
  expect(pollMessages(db, b.id).length).toBe(0);
});

test("pollMessages re-delivers after lease expiry", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "once" });
  const first = pollMessages(db, b.id);
  expect(first.length).toBe(1);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", first[0]!.id);
  const second = pollMessages(db, b.id);
  expect(second.length).toBe(1);
  expect(second[0]!.lease_token).not.toBe(first[0]!.lease_token);
});

test("pollMessages heartbeat is rolled back if tx throws", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "once" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", b.id);
  const before = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;

  db.exec("ALTER TABLE messages RENAME TO messages_bak");
  try {
    expect(() => pollMessages(db, b.id)).toThrow();
  } finally {
    db.exec("ALTER TABLE messages_bak RENAME TO messages");
  }

  const after = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;
  expect(after).toBe(before);
});

// ---------- ackMessages ----------

test("ackMessages marks matching rows as acked; later polls skip them", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id);
  const res = ackMessages(db, { id: b.id, lease_tokens: leased.map((m) => m.lease_token) });
  expect(res.acked).toBe(1);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  expect(pollMessages(db, b.id).length).toBe(0);
});

test("ackMessages REJECTS late acks whose lease has already expired", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  const res = ackMessages(db, { id: b.id, lease_tokens: leased.map((m) => m.lease_token) });
  expect(res.acked).toBe(0);
  // Message is therefore still deliverable
  const redelivered = pollMessages(db, b.id);
  expect(redelivered.length).toBe(1);
});

// ---------- renamePeer ----------

test("renamePeer to new unique name succeeds", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  const ok = renamePeer(db, { id: a.id, new_name: "gamma" });
  expect(ok.ok).toBe(true);
  expect(ok.name).toBe("gamma");
  expect(getPeerByName(db, "gamma")?.id).toBe(a.id);
});

test("renamePeer rejects duplicate name", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  const dup = renamePeer(db, { id: a.id, new_name: "beta" });
  expect(dup.ok).toBe(false);
  expect(dup.error).toMatch(/taken/i);
});

test("renamePeer rejects invalid name", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const bad = renamePeer(db, { id: a.id, new_name: "has space" });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/invalid/i);
});

// ---------- gcStalePeers ----------

test("gcStalePeers removes stale peers, preserves orphan messages", () => {
  const a = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha",
  });
  const b = registerPeer(db, {
    peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta",
  });
  sendMessage(db, {
    from_id: a.id, to_id_or_name: "beta", text: "you will die before reading this",
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", b.id);
  const removed = gcStalePeers(db);
  expect(removed).toBe(1);
  expect(getPeer(db, b.id)).toBeNull();
  const remaining = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ?"
  ).get(b.id);
  expect(remaining?.c).toBe(1);
  const orphans = listOrphanedMessages(db);
  expect(orphans.length).toBe(1);
  expect(orphans[0]!.to_id).toBe(b.id);
  expect(orphans[0]!.text).toBe("you will die before reading this");
});

test("gcStalePeers does NOT delete a peer whose last_seen was refreshed", () => {
  const p = registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "racewin",
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", p.id);
  // Simulate a concurrent reclaim refreshing last_seen
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date().toISOString(), p.id);
  const removed = gcStalePeers(db);
  expect(removed).toBe(0);
  expect(getPeer(db, p.id)).not.toBeNull();
});
