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
  adminRenamePeer,
  gcStalePeers,
  listOrphanedMessages,
} from "../broker.ts";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

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

// Helper: register and return a full auth handle.
function reg(opts: {
  name?: string;
  peer_type?: "claude" | "codex";
  cwd?: string;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  pid?: number;
}) {
  return registerPeer(db, {
    peer_type: opts.peer_type ?? "claude",
    pid: opts.pid ?? 1,
    cwd: opts.cwd ?? "/x",
    git_root: opts.git_root ?? null,
    tty: opts.tty ?? null,
    summary: opts.summary ?? "",
    ...(opts.name ? { name: opts.name } : {}),
  });
}

// ---------- schema ----------

test("initDb creates tables and indices with WAL", () => {
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r) => r.name);
  expect(tables).toContain("peers");
  expect(tables).toContain("messages");

  const pragma = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(pragma?.journal_mode.toLowerCase()).toBe("wal");
});

// ---------- peer CRUD ----------

test("registerPeer creates peer with UUID + name + session_token", () => {
  const { id, name, session_token } = reg({});
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(session_token).toMatch(/^[a-f0-9-]{36}$/);
  expect(name.length).toBeGreaterThan(0);
  const peer = getPeer(db, id);
  expect(peer?.name).toBe(name);
});

test("registerPeer honors explicit name if unique", () => {
  const { name } = reg({ name: "frontend-tab", peer_type: "codex" });
  expect(name).toBe("frontend-tab");
});

test("registerPeer appends -2 on name collision with live peer", () => {
  const a = reg({ name: "dup" });
  const b = reg({ name: "dup" });
  expect(a.name).toBe("dup");
  expect(b.name).toBe("dup-2");
});

test("registerPeer reclaims stale peer with same name, preserving UUID and issuing NEW session_token", () => {
  const first = reg({ name: "persistent" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", first.id);
  const second = reg({ name: "persistent", pid: 222, cwd: "/new" });
  expect(second.id).toBe(first.id);
  expect(second.name).toBe("persistent");
  expect(second.session_token).not.toBe(first.session_token); // rotated
  const row = db.query<{ pid: number; cwd: string }, [string]>(
    "SELECT pid, cwd FROM peers WHERE id = ?"
  ).get(second.id)!;
  expect(row.pid).toBe(222);
  expect(row.cwd).toBe("/new");
});

test("registerPeer does NOT reclaim a LIVE peer, falls through to suffix", () => {
  const live = reg({ name: "active" });
  const second = reg({ name: "active" });
  expect(second.id).not.toBe(live.id);
  expect(second.name).toBe("active-2");
});

test("registerPeer is atomic under simulated interleaving", () => {
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "external-id", "race", "claude", 99, "/ext", null, null, "",
    "external-session", new Date().toISOString(), new Date().toISOString(),
  );
  const res = reg({ name: "race" });
  expect(res.name).toBe("race-2");
});

test("heartbeatPeer bumps last_seen with valid token", async () => {
  const a = reg({});
  const initial = getPeer(db, a.id)!.last_seen;
  await new Promise((r) => setTimeout(r, 20));
  heartbeatPeer(db, a.id, a.session_token);
  expect(getPeer(db, a.id)!.last_seen > initial).toBe(true);
});

test("heartbeatPeer with WRONG token silently no-ops (auth)", async () => {
  const a = reg({});
  const initial = getPeer(db, a.id)!.last_seen;
  await new Promise((r) => setTimeout(r, 20));
  heartbeatPeer(db, a.id, "wrong-token");
  expect(getPeer(db, a.id)!.last_seen).toBe(initial);
});

test("setPeerSummary updates summary with valid token", () => {
  const a = reg({});
  setPeerSummary(db, a.id, a.session_token, "Working on X");
  expect(getPeer(db, a.id)?.summary).toBe("Working on X");
});

test("setPeerSummary with wrong token is silently ignored (auth)", () => {
  const a = reg({});
  setPeerSummary(db, a.id, "wrong", "MALICIOUS");
  expect(getPeer(db, a.id)?.summary).toBe("");
});

test("unregisterPeer removes peer row with valid token, preserves messages", () => {
  const a = reg({ name: "a" });
  const b = reg({ name: "b" });
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "b", text: "hi" });
  unregisterPeer(db, b.id, b.session_token);
  expect(getPeer(db, b.id)).toBeNull();
  const remaining = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ?"
  ).get(b.id);
  expect(remaining?.c).toBe(1);
});

test("unregisterPeer with wrong token silently no-ops (auth — cannot delete another peer)", () => {
  const a = reg({ name: "a" });
  const b = reg({ name: "b" });
  // 'a' tries to unregister 'b' using a's token
  unregisterPeer(db, b.id, a.session_token);
  expect(getPeer(db, b.id)).not.toBeNull();
});

// ---------- listPeers ----------

test("listPeers scope=machine returns all minus excluded", () => {
  const a = reg({});
  const b = reg({ peer_type: "codex" });
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null, exclude_id: a.id });
  expect(peers.map((p) => p.id)).toEqual([b.id]);
});

test("listPeers scope=directory filters by cwd", () => {
  const a = reg({ cwd: "/x" });
  reg({ cwd: "/y" });
  const peers = listPeers(db, { scope: "directory", cwd: "/x", git_root: null });
  expect(peers.map((p) => p.id)).toEqual([a.id]);
});

test("listPeers scope=repo filters by git_root", () => {
  const a = reg({ cwd: "/x/sub", git_root: "/x" });
  reg({ cwd: "/y", git_root: "/y" });
  const peers = listPeers(db, { scope: "repo", cwd: "/x", git_root: "/x" });
  expect(peers.map((p) => p.id)).toEqual([a.id]);
});

test("listPeers peer_type filter", () => {
  reg({});
  const c = reg({ peer_type: "codex" });
  const peers = listPeers(db, {
    scope: "machine", cwd: "/any", git_root: null, peer_type: "codex",
  });
  expect(peers.map((p) => p.id)).toEqual([c.id]);
});

// ---------- sendMessage ----------

test("sendMessage by id with valid session stores message", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "hi",
  });
  expect(res.ok).toBe(true);
  expect(typeof res.message_id).toBe("number");
});

test("sendMessage by name resolves to id", () => {
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "hi",
  });
  expect(res.ok).toBe(true);
});

test("sendMessage unknown target returns ok=false", () => {
  const a = reg({ name: "alpha" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "nobody", text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unknown peer/i);
});

test("sendMessage with forged from_id is rejected (auth)", () => {
  const b = reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: "not-a-real-id", session_token: "fake", to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unauthorized|unknown/i);
});

test("sendMessage with WRONG session_token for real from_id is rejected (auth)", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: "wrong", to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unauthorized/i);
});

test("sendMessage with stale sender is rejected", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", a.id);
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/sender stale/i);
});

test("sendMessage to stale target is rejected", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", b.id);
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/target peer stale/i);
});

// ---------- pollMessages ----------

function pair() {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  return { a, b };
}

test("pollMessages with WRONG session_token returns empty (no drain)", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "secret" });
  const stranger = pollMessages(db, b.id, "wrong-token");
  expect(stranger).toEqual([]);
  // Legitimate owner still can
  expect(pollMessages(db, b.id, b.session_token).length).toBe(1);
});

test("pollMessages with unknown peer id returns empty", () => {
  const stranger = pollMessages(db, "00000000-0000-0000-0000-000000000000", "any");
  expect(stranger).toEqual([]);
});

test("pollMessages returns leased messages with enriched fields", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "ping" });
  const out = pollMessages(db, b.id, b.session_token);
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("ping");
  expect(out[0]!.from_name).toBe("alpha");
  expect(out[0]!.from_peer_type).toBe("claude");
  expect(out[0]!.lease_token).toMatch(/^[a-f0-9-]{36}$/);
});

test("pollMessages twice does not re-deliver while lease active", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "once" });
  expect(pollMessages(db, b.id, b.session_token).length).toBe(1);
  expect(pollMessages(db, b.id, b.session_token).length).toBe(0);
});

test("pollMessages re-delivers after lease expiry", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "once" });
  const first = pollMessages(db, b.id, b.session_token);
  expect(first.length).toBe(1);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", first[0]!.id);
  const second = pollMessages(db, b.id, b.session_token);
  expect(second.length).toBe(1);
  expect(second[0]!.lease_token).not.toBe(first[0]!.lease_token);
});

test("pollMessages heartbeat is rolled back if tx throws", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "once" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", b.id);
  const before = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;

  db.exec("ALTER TABLE messages RENAME TO messages_bak");
  try {
    expect(() => pollMessages(db, b.id, b.session_token)).toThrow();
  } finally {
    db.exec("ALTER TABLE messages_bak RENAME TO messages");
  }

  const after = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;
  expect(after).toBe(before);
});

// ---------- ackMessages ----------

test("ackMessages with valid session marks rows acked", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id, b.session_token);
  const res = ackMessages(db, {
    id: b.id, session_token: b.session_token, lease_tokens: leased.map((m) => m.lease_token),
  });
  expect(res.acked).toBe(1);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  expect(pollMessages(db, b.id, b.session_token).length).toBe(0);
});

test("ackMessages with WRONG session_token returns acked=0 (auth)", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id, b.session_token);
  const res = ackMessages(db, {
    id: b.id, session_token: "wrong", lease_tokens: leased.map((m) => m.lease_token),
  });
  expect(res.acked).toBe(0);
});

test("ackMessages with unknown peer id returns acked=0", () => {
  const res = ackMessages(db, {
    id: "00000000-0000-0000-0000-000000000000",
    session_token: "any",
    lease_tokens: ["anything"],
  });
  expect(res.acked).toBe(0);
});

test("ackMessages REJECTS late acks whose lease has already expired", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id, b.session_token);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  const res = ackMessages(db, {
    id: b.id, session_token: b.session_token, lease_tokens: leased.map((m) => m.lease_token),
  });
  expect(res.acked).toBe(0);
  expect(pollMessages(db, b.id, b.session_token).length).toBe(1);
});

// ---------- renamePeer (peer-auth) + adminRenamePeer ----------

test("renamePeer with valid session_token succeeds", () => {
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const ok = renamePeer(db, { id: a.id, session_token: a.session_token, new_name: "gamma" });
  expect(ok.ok).toBe(true);
  expect(ok.name).toBe("gamma");
  expect(getPeerByName(db, "gamma")?.id).toBe(a.id);
});

test("renamePeer with WRONG session_token is rejected (auth — no peer impersonation)", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  // b tries to rename a using b's token
  const res = renamePeer(db, { id: a.id, session_token: b.session_token, new_name: "ha" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unauthorized/i);
  expect(getPeerByName(db, "alpha")?.id).toBe(a.id);
});

test("renamePeer rejects duplicate name", () => {
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const dup = renamePeer(db, { id: a.id, session_token: a.session_token, new_name: "beta" });
  expect(dup.ok).toBe(false);
  expect(dup.error).toMatch(/taken/i);
});

test("renamePeer rejects invalid name", () => {
  const a = reg({ name: "alpha" });
  const bad = renamePeer(db, { id: a.id, session_token: a.session_token, new_name: "has space" });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/invalid/i);
});

test("adminRenamePeer renames without session token (localhost operator action)", () => {
  const a = reg({ name: "alpha" });
  const res = adminRenamePeer(db, { id: a.id, new_name: "renamed" });
  expect(res.ok).toBe(true);
  expect(getPeerByName(db, "renamed")?.id).toBe(a.id);
});

// ---------- gcStalePeers ----------

test("gcStalePeers removes stale peers, preserves orphan messages", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta",
    text: "you will die before reading this",
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
});

test("gcStalePeers does NOT delete a peer whose last_seen was refreshed", () => {
  const p = reg({ name: "racewin" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", p.id);
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date().toISOString(), p.id);
  const removed = gcStalePeers(db);
  expect(removed).toBe(0);
  expect(getPeer(db, p.id)).not.toBeNull();
});
