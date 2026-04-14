// Regression: opening a DB file created by the PRE-session_token schema must
// transparently migrate, drop pre-upgrade peers, then serve register/send/poll
// normally for freshly-registered peers. Self-heal on NULL tokens.
// Code review round-3/round-4 findings.

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDb,
  registerPeer,
  sendMessage,
  pollMessages,
  ackMessages,
} from "../broker.ts";
import { unlinkSync, existsSync } from "node:fs";

let TEST_DB: string;
afterEach(() => {
  if (TEST_DB && existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

function createLegacyDb(path: string) {
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

test("initDb migrates pre-session_token DB: adds column, DROPS legacy peers, messages table intact", () => {
  TEST_DB = `/tmp/agent-peers-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);

  // Seed a pre-existing message (pretend in-flight) so we can check it survives
  // as an orphan after peer deletion.
  const seed = new Database(TEST_DB);
  seed.query(
    `INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)`
  ).run("legacy-uuid-1", "legacy-uuid-2", "pre-upgrade in-flight", new Date().toISOString());
  seed.close();

  const db = initDb(TEST_DB);
  try {
    // Column now exists
    const cols = db.query<{ name: string }, []>(
      `SELECT name FROM pragma_table_info('peers')`
    ).all().map((r) => r.name);
    expect(cols).toContain("session_token");

    // Legacy peer rows are gone (migration drops them)
    const peerCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM peers"
    ).get()!.c;
    expect(peerCount).toBe(0);

    // Pre-upgrade message survives (now visible as orphan via the LEFT JOIN)
    const msgCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM messages WHERE acked = 0"
    ).get()!.c;
    expect(msgCount).toBe(1);
  } finally {
    db.close();
  }
});

test("after migration, fresh register + send + poll + ack works normally", () => {
  TEST_DB = `/tmp/agent-peers-migration2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);
  const db = initDb(TEST_DB);

  try {
    const a = registerPeer(db, {
      peer_type: "claude", pid: 1, cwd: "/new", git_root: null, tty: null, summary: "", name: "fresh-a",
    });
    const b = registerPeer(db, {
      peer_type: "claude", pid: 2, cwd: "/new", git_root: null, tty: null, summary: "", name: "fresh-b",
    });
    const sent = sendMessage(db, {
      from_id: a.id, session_token: a.session_token, to_id_or_name: "fresh-b", text: "post-upgrade hello",
    });
    expect(sent.ok).toBe(true);

    const leased = pollMessages(db, b.id, b.session_token);
    expect(leased.length).toBe(1);
    expect(leased[0]!.text).toBe("post-upgrade hello");

    const acked = ackMessages(db, {
      id: b.id, session_token: b.session_token,
      lease_tokens: leased.map((m) => m.lease_token),
    });
    expect(acked.acked).toBe(1);
  } finally {
    db.close();
  }
});

test("initDb is idempotent on an already-migrated DB", () => {
  TEST_DB = `/tmp/agent-peers-migration3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);

  const db1 = initDb(TEST_DB);
  db1.close();
  // Second open should do nothing destructive
  const db2 = initDb(TEST_DB);
  try {
    const cols = db2.query<{ name: string }, []>(
      `SELECT name FROM pragma_table_info('peers')`
    ).all().map((r) => r.name);
    expect(cols).toContain("session_token");
  } finally {
    db2.close();
  }
});

test("initDb self-heals NULL session_token rows from a crashed partial migration", () => {
  TEST_DB = `/tmp/agent-peers-migration4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  // Start with a post-migration schema (column exists) but a row with NULL token,
  // simulating a crash after ALTER TABLE but before backfill.
  const setup = new Database(TEST_DB);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.exec(`
    CREATE TABLE peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  setup.exec(`
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
  const ts = new Date().toISOString();
  // Insert row with NULL session_token
  setup.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run("half-migrated-1", "half", "claude", 1, "/half", null, null, "", ts, ts);
  setup.close();

  // initDb should self-heal the NULL token
  const db = initDb(TEST_DB);
  try {
    const row = db.query<{ session_token: string }, []>(
      "SELECT session_token FROM peers WHERE id = 'half-migrated-1'"
    ).get();
    expect(row?.session_token).toMatch(/^[a-f0-9-]{36}$/);
  } finally {
    db.close();
  }
});
