// Regression: opening a DB file created by the PRE-session_token schema must
// transparently migrate + backfill, then serve register/send/poll/ack normally.
// Code review round-3 finding.

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDb,
  registerPeer,
  sendMessage,
  pollMessages,
  ackMessages,
  heartbeatPeer,
  getPeer,
} from "../broker.ts";
import { unlinkSync, existsSync } from "node:fs";

let TEST_DB: string;
afterEach(() => {
  if (TEST_DB && existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

function createLegacyDb(path: string) {
  // Replicates the broker's CREATE TABLE schema from BEFORE the session_token
  // column was added. Represents a pre-existing deployment.
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT
    );
  `);
  // Seed some rows representing the pre-upgrade state
  const ts = new Date().toISOString();
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("legacy-uuid-1", "legacy-alpha", "claude", 1, "/legacy", null, null, "", ts, ts);
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("legacy-uuid-2", "legacy-beta", "codex", 2, "/legacy", null, null, "", ts, ts);
  db.close();
}

test("initDb migrates a pre-session_token DB: adds column, backfills tokens, keeps UUIDs", () => {
  TEST_DB = `/tmp/agent-peers-migration-${Date.now()}.db`;
  createLegacyDb(TEST_DB);

  const db = initDb(TEST_DB);
  try {
    // Column now exists
    const cols = db.query<{ name: string }, []>(
      `SELECT name FROM pragma_table_info('peers')`
    ).all().map((r) => r.name);
    expect(cols).toContain("session_token");

    // Both legacy rows got backfilled with a valid UUID-shaped token
    const rows = db.query<{ id: string; session_token: string }, []>(
      "SELECT id, session_token FROM peers ORDER BY id"
    ).all();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.session_token).toMatch(/^[a-f0-9-]{36}$/);
    }
    // UUIDs preserved
    expect(rows.map((r) => r.id)).toEqual(["legacy-uuid-1", "legacy-uuid-2"]);
  } finally {
    db.close();
  }
});

test("after migration, register/send/poll/ack all work normally", () => {
  TEST_DB = `/tmp/agent-peers-migration2-${Date.now()}.db`;
  createLegacyDb(TEST_DB);
  const db = initDb(TEST_DB);

  try {
    // The legacy peers don't have client-known session tokens — their
    // heartbeat would silently no-op. That's acceptable: they'll expire via
    // GC in 60s. Now test that a new register alongside them works:
    const fresh = registerPeer(db, {
      peer_type: "claude", pid: 9, cwd: "/new", git_root: null, tty: null, summary: "", name: "fresh",
    });
    expect(fresh.session_token).toMatch(/^[a-f0-9-]{36}$/);

    // Look up a legacy peer's backfilled token and confirm heartbeat works with it
    const legacyToken = db.query<{ session_token: string }, [string]>(
      "SELECT session_token FROM peers WHERE id = ?"
    ).get("legacy-uuid-1")!.session_token;

    // First refresh legacy-uuid-1's last_seen so sendMessage target-liveness passes
    heartbeatPeer(db, "legacy-uuid-1", legacyToken);
    const refreshed = getPeer(db, "legacy-uuid-1");
    expect(refreshed).not.toBeNull();

    // Send from fresh peer to legacy peer by name
    const sent = sendMessage(db, {
      from_id: fresh.id, session_token: fresh.session_token,
      to_id_or_name: "legacy-alpha", text: "hello legacy",
    });
    expect(sent.ok).toBe(true);

    // Legacy peer polls using backfilled token
    const leased = pollMessages(db, "legacy-uuid-1", legacyToken);
    expect(leased.length).toBe(1);
    expect(leased[0]!.text).toBe("hello legacy");

    const acked = ackMessages(db, {
      id: "legacy-uuid-1", session_token: legacyToken,
      lease_tokens: leased.map((m) => m.lease_token),
    });
    expect(acked.acked).toBe(1);
  } finally {
    db.close();
  }
});

test("initDb is idempotent on an already-migrated DB (second call is a no-op)", () => {
  TEST_DB = `/tmp/agent-peers-migration3-${Date.now()}.db`;
  createLegacyDb(TEST_DB);

  const db1 = initDb(TEST_DB);
  db1.close();
  // Second open should not throw and should not alter anything
  const db2 = initDb(TEST_DB);
  try {
    const rows = db2.query<{ session_token: string }, []>(
      "SELECT session_token FROM peers"
    ).all();
    expect(rows.every((r) => /^[a-f0-9-]{36}$/.test(r.session_token))).toBe(true);
  } finally {
    db2.close();
  }
});
