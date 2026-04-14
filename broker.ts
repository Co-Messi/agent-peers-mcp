#!/usr/bin/env bun
// broker.ts
// HTTP + SQLite daemon for agent-peers-mcp. Runs on localhost:7900.
// Spec: docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, openSync, closeSync, writeSync, fsyncSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { validateSecretFilePerms } from "./shared/shared-secret.ts";
import type {
  RegisterRequest, RegisterResponse, Peer,
  ListPeersRequest, SendMessageRequest, SendMessageResponse,
  LeasedMessage, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
} from "./shared/types.ts";
import { generateName, isValidName, NAME_MAX_LEN, NAME_REGEX } from "./shared/names.ts";

export const DEFAULT_DB_PATH = resolve(homedir(), ".agent-peers.db");
export const DEFAULT_SECRET_PATH = resolve(homedir(), ".agent-peers-secret");
export const DEFAULT_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
export const STALE_THRESHOLD_MS = 60_000;
export const STALE_RECLAIM_THRESHOLD_MS = 60_000;
export const LEASE_DURATION_MS = 30_000;
export const GC_INTERVAL_MS = 30_000;
export const SECRET_HEADER = "x-agent-peers-secret";

function nowIso(): string { return new Date().toISOString(); }

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

// ----- Schema -----

function chmodIfExists(p: string, mode: number): void {
  try { chmodSync(p, mode); } catch { /* file may not exist yet, or no POSIX perms — best effort */ }
}

export function initDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Harden filesystem permissions on the DB + its WAL sidecars. Codex round-E
  // flagged that SQLite creates files with the process umask (typically 022,
  // world-readable), which would expose session_tokens + message bodies to
  // any local user. cli.ts 'messages' / 'rename' treat the DB's file perms
  // as the operator trust boundary, so 0600 enforcement is required.
  chmodIfExists(path, 0o600);
  chmodIfExists(path + "-wal", 0o600);
  chmodIfExists(path + "-shm", 0o600);

  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to_acked ON messages(to_id, acked);`);

  // ---- Migrations for upgrades against a pre-existing DB file ----
  // Add columns that newer code requires but the old schema lacks. Use
  // pragma_table_info to detect missing columns, then ALTER TABLE to add them
  // and backfill sensible defaults.

  migrate_peers_add_session_token(db);

  // Re-enforce 0600 AFTER migration + any CREATE TABLE writes — the initial
  // chmod before schema setup may have no-op'd on nonexistent sidecars, so
  // we harden again here once SQLite has definitely materialized the WAL/
  // SHM files at least once. Closes the Codex round-F "world-readable
  // sidecars during startup" window (previously waited up to 30s for the
  // GC tick to re-apply).
  chmodIfExists(path, 0o600);
  chmodIfExists(path + "-wal", 0o600);
  chmodIfExists(path + "-shm", 0o600);

  return db;
}

function columnExists(db: Database, table: string, column: string): boolean {
  // pragma_table_info() doesn't accept bound parameters reliably across SQLite
  // builds, so we inline the table name with hardening (single-quote escaping).
  // This is only ever called with compile-time-known table names.
  const safe = table.replace(/'/g, "''");
  const rows = db.query<{ name: string }, []>(
    `SELECT name FROM pragma_table_info('${safe}')`
  ).all();
  return rows.some((r) => r.name === column);
}

function migrate_peers_add_session_token(db: Database): void {
  // Wrapped in BEGIN IMMEDIATE so concurrent broker startups serialize the
  // schema check + mutation (code review round-4 fix). Without this, process A
  // can run ALTER TABLE while process B races past the columnExists check and
  // proceeds against a half-migrated DB.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "peers", "session_token")) {
      // First-time upgrade from a pre-session_token schema.
      db.exec(`ALTER TABLE peers ADD COLUMN session_token TEXT`);
      // Drop all pre-upgrade peer rows (round-4 fix for "migrated legacy peers
      // can silently receive undeliverable messages"). Pre-upgrade clients
      // don't know the new session_token scheme, so they cannot authenticate.
      // Leaving their rows in place would make them addressable via
      // sendMessage but unpollable — messages would orphan silently. Deleting
      // forces a clean reconnect: clients get "unknown peer" on their next
      // heartbeat/send and re-register. Any in-flight messages for these
      // peers become orphans, observable via cli.ts orphaned-messages.
      const dropped = db.query("DELETE FROM peers").run();
      if ((dropped.changes ?? 0) > 0) {
        console.error(
          `[broker] migration: dropped ${dropped.changes} pre-upgrade peer(s); ` +
          `they will re-register on reconnect. In-flight messages to them are visible ` +
          `via 'bun cli.ts orphaned-messages'.`
        );
      }
    }
    // Self-heal: any row with NULL session_token (e.g. from a crashed partial
    // migration before this transactional logic existed) gets a freshly
    // generated UUID. Always runs, regardless of column-newness.
    const nulls = db.query<{ id: string }, []>(
      "SELECT id FROM peers WHERE session_token IS NULL"
    ).all();
    if (nulls.length > 0) {
      const update = db.query("UPDATE peers SET session_token = ? WHERE id = ?");
      for (const row of nulls) update.run(randomUUID(), row.id);
      console.error(`[broker] migration: self-healed ${nulls.length} NULL session_token(s)`);
    }
    // Normalize schema (code review round-5 fix): ALTER TABLE ADD COLUMN
    // leaves session_token nullable on upgraded DBs even though fresh installs
    // declare it NOT NULL. A future writer that inserts a NULL (e.g. a bug, a
    // manual edit) would re-introduce the silent-orphan class. Rebuild the
    // table to enforce NOT NULL, matching the fresh-install invariant.
    if (isSessionTokenNullable(db)) {
      rebuildPeersTableWithNotNullSessionToken(db);
      console.error(`[broker] migration: rebuilt peers table with NOT NULL session_token`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function isSessionTokenNullable(db: Database): boolean {
  // pragma_table_info.notnull is 0 when the column is nullable, 1 when NOT NULL.
  // Alias to a non-reserved name for portability.
  const row = db.query<{ not_null_flag: number }, []>(
    `SELECT "notnull" AS not_null_flag FROM pragma_table_info('peers') WHERE name = 'session_token'`
  ).get();
  return row ? row.not_null_flag === 0 : false;
}

function rebuildPeersTableWithNotNullSessionToken(db: Database): void {
  // Create a shadow table with the desired strict schema, copy only rows that
  // have a non-NULL session_token (defense — callers above already self-healed),
  // drop the old table, rename. All inside the outer BEGIN IMMEDIATE tx, so
  // readers/writers see either the old table or the renamed new table, never
  // an in-between state.
  db.exec(`
    CREATE TABLE peers_new (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO peers_new (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
    SELECT id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen
    FROM peers
    WHERE session_token IS NOT NULL;
  `);
  db.exec(`DROP TABLE peers;`);
  db.exec(`ALTER TABLE peers_new RENAME TO peers;`);
  // Rebuild the indices that lived on the old table.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);`);
}

// ----- Peer CRUD -----

function* nameCandidates(requested: string | undefined): Generator<string> {
  if (requested && isValidName(requested)) {
    yield requested;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${requested}-${i}`;
      if (candidate.length <= NAME_MAX_LEN) yield candidate;
    }
  }
  for (let i = 0; i < 100; i++) yield generateName();
  for (let i = 2; i <= 999; i++) {
    const candidate = `${generateName()}-${i}`;
    if (candidate.length <= NAME_MAX_LEN) yield candidate;
  }
}

export function registerPeer(db: Database, req: RegisterRequest): RegisterResponse {
  const ts = nowIso();
  // Every register (fresh or reclaim) issues a new session_token. Reclaim
  // rotates the token so the previous session's client (if it's still alive
  // elsewhere) can no longer act as this peer — the token is the session
  // boundary.
  const session_token = randomUUID();

  // Reclaim fast-path: stale peer with matching name → UPDATE in place, preserve UUID.
  if (req.name && isValidName(req.name)) {
    const cutoff = new Date(Date.now() - STALE_RECLAIM_THRESHOLD_MS).toISOString();
    const reclaim = db.query(
      `UPDATE peers
         SET peer_type = ?, pid = ?, cwd = ?, git_root = ?, tty = ?, summary = ?,
             session_token = ?, last_seen = ?
       WHERE name = ? AND last_seen < ?`
    ).run(
      req.peer_type, req.pid, req.cwd, req.git_root, req.tty, req.summary,
      session_token, ts, req.name, cutoff,
    );
    if ((reclaim.changes ?? 0) > 0) {
      const row = db.query<{ id: string }, [string]>("SELECT id FROM peers WHERE name = ?").get(req.name);
      if (row) return { id: row.id, name: req.name, session_token };
    }
  }

  // Fresh INSERT with suffix ladder.
  const id = randomUUID();
  const insert = db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const candidate of nameCandidates(req.name)) {
    try {
      insert.run(
        id, candidate, req.peer_type, req.pid, req.cwd, req.git_root, req.tty, req.summary,
        session_token, ts, ts,
      );
      return { id, name: candidate, session_token };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("broker: unable to allocate unique peer name after exhaustive retry");
}

// NOTE: authPeer() was removed after Codex round-C audit. Every mutating
// operation now binds `session_token` directly in its SQL WHERE clause so
// auth and mutation are one atomic statement — eliminating the TOCTOU
// window that allowed a stale session to mutate a reclaim-rotated peer.

// heartbeat/unregister/setSummary: session_token is folded directly into
// every mutation's WHERE clause so the auth check and the mutation are ONE
// atomic statement. A separate authPeer() pre-check would leave a TOCTOU
// window where a reclaim (which rotates session_token) can happen between
// the check and the mutation, letting an old session mutate the reclaimed
// peer's row. Binding the token in WHERE closes that race.

export function heartbeatPeer(db: Database, id: string, session_token: string): void {
  db.query("UPDATE peers SET last_seen = ? WHERE id = ? AND session_token = ?")
    .run(nowIso(), id, session_token);
}

export function unregisterPeer(db: Database, id: string, session_token: string): void {
  // Messages stay as orphans (spec §5.1).
  db.query("DELETE FROM peers WHERE id = ? AND session_token = ?")
    .run(id, session_token);
}

export function setPeerSummary(db: Database, id: string, session_token: string, summary: string): void {
  db.query("UPDATE peers SET summary = ?, last_seen = ? WHERE id = ? AND session_token = ?")
    .run(summary, nowIso(), id, session_token);
}

// Both getters deliberately use explicit column projection (NOT `SELECT *`)
// so `session_token` never leaks into a Peer object that could be serialized
// back to a client. authPeer() is the only code path that touches
// session_token, and it does its own narrow query.
const PEER_COLS =
  "id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen";

export function getPeer(db: Database, id: string): Peer | null {
  const row = db.query<Peer, [string]>(`SELECT ${PEER_COLS} FROM peers WHERE id = ?`).get(id);
  return row ?? null;
}

export function getPeerByName(db: Database, name: string): Peer | null {
  const row = db.query<Peer, [string]>(`SELECT ${PEER_COLS} FROM peers WHERE name = ?`).get(name);
  return row ?? null;
}

// ----- Listing -----

export function listPeers(db: Database, req: ListPeersRequest): Peer[] {
  // Opportunistic cleanup — run GC before listing so a user who just closed a
  // session tab doesn't see their own ghost peer. Complements the 30s timer GC.
  gcStalePeers(db);

  const clauses: string[] = [];
  const params: (string | null)[] = [];

  // Always hide stale peers from discovery. Even if timer/opportunistic GC
  // hasn't removed the row yet (it happens <= 30s after heartbeat stops),
  // the `last_seen >= cutoff` predicate filters them out of visible results.
  // This is what closes the "closed the tab but peer still shows up" gap.
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  clauses.push("last_seen >= ?");
  params.push(cutoff);

  if (req.scope === "directory") {
    clauses.push("cwd = ?");
    params.push(req.cwd);
  } else if (req.scope === "repo") {
    if (req.git_root) {
      clauses.push("git_root = ?");
      params.push(req.git_root);
    } else {
      clauses.push("cwd = ?");
      params.push(req.cwd);
    }
  }
  if (req.exclude_id) {
    clauses.push("id != ?");
    params.push(req.exclude_id);
  }
  if (req.peer_type) {
    clauses.push("peer_type = ?");
    params.push(req.peer_type);
  }

  // CRITICAL: explicit column projection — NEVER `SELECT *`. A prior version
  // used `SELECT *` which leaked `session_token` into the public discovery
  // response, collapsing the entire auth model (anyone who could list peers
  // could impersonate them). Whitelist the safe columns here and keep
  // `session_token` out of every client-facing payload.
  const where = `WHERE ${clauses.join(" AND ")}`;
  const sql = `SELECT id, name, peer_type, pid, cwd, git_root, tty, summary,
                      registered_at, last_seen
               FROM peers ${where} ORDER BY last_seen DESC`;
  return db.query<Peer, typeof params>(sql).all(...params);
}

// ----- Send -----

function isStale(last_seen_iso: string): boolean {
  const t = Date.parse(last_seen_iso);
  return !Number.isFinite(t) || (Date.now() - t) > STALE_THRESHOLD_MS;
}

function resolveTarget(db: Database, to_id_or_name: string): Peer | null {
  const byId = getPeer(db, to_id_or_name);
  if (byId) return byId;
  return getPeerByName(db, to_id_or_name);
}

export function sendMessage(db: Database, req: SendMessageRequest): SendMessageResponse {
  // Atomic sender auth + target resolution + liveness check + insert, all in
  // a single transaction so nothing can unregister or re-register between
  // steps and orphan a "successful" message (Codex round-D TOCTOU fix).
  const nowStr = nowIso();
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const tx = db.transaction((): SendMessageResponse => {
    // 1. Sender auth (atomic: id + session_token + live)
    const sender = db.query<{ name: string }, [string, string, string]>(
      "SELECT name FROM peers WHERE id = ? AND session_token = ? AND last_seen >= ?"
    ).get(req.from_id, req.session_token, staleCutoff);
    if (!sender) {
      // Distinguish unauthorized vs stale for a better error message.
      const row = db.query<{ last_seen: string; name: string }, [string, string]>(
        "SELECT last_seen, name FROM peers WHERE id = ? AND session_token = ?"
      ).get(req.from_id, req.session_token);
      if (!row) return { ok: false, error: `unauthorized sender: ${req.from_id}` };
      return { ok: false, error: `sender stale: ${row.name}` };
    }

    // 2. Target resolution + liveness + insert in ONE statement. The insert
    //    only succeeds if the target resolves to a LIVE peer row. If the
    //    target is unregistered or goes stale between the sender check and
    //    the insert, we fail closed with ok=false rather than writing an
    //    orphan.
    const inserted = db.query<
      { id: number; to_id: string },
      [string, string, string, string, string, string]
    >(
      `INSERT INTO messages (from_id, to_id, text, sent_at)
       SELECT ?, p.id, ?, ?
       FROM peers p
       WHERE (p.id = ? OR p.name = ?)
         AND p.last_seen >= ?
       RETURNING id, to_id`
    ).get(req.from_id, req.text, nowStr, req.to_id_or_name, req.to_id_or_name, staleCutoff);

    if (!inserted) {
      // Either no peer matches the id-or-name, or the matched peer is stale.
      // Distinguish for a better error.
      const target = resolveTarget(db, req.to_id_or_name);
      if (!target) return { ok: false, error: `unknown peer: ${req.to_id_or_name}` };
      return { ok: false, error: `target peer stale: ${target.name}` };
    }
    return { ok: true, message_id: inserted.id };
  });

  return tx();
}

// ----- Poll (lease) -----

export function pollMessages(db: Database, id: string, session_token: string): LeasedMessage[] {
  const now = new Date();
  const nowStr = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  const tx = db.transaction(() => {
    // Session-token auth — caller must prove peer ownership.
    // The UPDATE with both predicates serves as atomic auth + heartbeat:
    // if the token doesn't match or the peer is gone, 0 rows update, and we
    // return empty (matches "no messages" semantically, without exposing
    // anyone's mailbox).
    const hbInfo = db.query(
      "UPDATE peers SET last_seen = ? WHERE id = ? AND session_token = ?"
    ).run(nowStr, id, session_token);
    if ((hbInfo.changes ?? 0) === 0) {
      return [] as LeasedMessage[];
    }

    const rows = db.query<
      { id: number; from_id: string; to_id: string; text: string; sent_at: string },
      [string, string]
    >(
      `SELECT id, from_id, to_id, text, sent_at
       FROM messages
       WHERE to_id = ? AND acked = 0
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
       ORDER BY id ASC`
    ).all(id, nowStr);

    const result: LeasedMessage[] = [];
    for (const row of rows) {
      const lease = randomUUID();
      db.query("UPDATE messages SET lease_token = ?, lease_expires_at = ? WHERE id = ?")
        .run(lease, leaseUntil, row.id);
      const sender = getPeer(db, row.from_id);
      result.push({
        id: row.id,
        from_id: row.from_id,
        from_name: sender?.name ?? "(gone)",
        from_peer_type: (sender?.peer_type ?? "claude") as "claude" | "codex",
        from_cwd: sender?.cwd ?? "",
        from_summary: sender?.summary ?? "",
        to_id: row.to_id,
        text: row.text,
        sent_at: row.sent_at,
        lease_token: lease,
      });
    }
    return result;
  });

  return tx();
}

// ----- Ack -----

export function ackMessages(db: Database, req: AckMessagesRequest): AckMessagesResponse {
  if (req.lease_tokens.length === 0) return { ok: true, acked: 0 };
  // Atomic auth via subquery: the UPDATE only affects messages whose to_id
  // belongs to a peer row with the matching session_token. No separate
  // pre-check → no TOCTOU window across reclaim-rotation.
  const placeholders = req.lease_tokens.map(() => "?").join(",");
  const sql = `UPDATE messages SET acked = 1, lease_token = NULL, lease_expires_at = NULL
               WHERE lease_token IN (${placeholders})
                 AND to_id = (SELECT id FROM peers WHERE id = ? AND session_token = ?)
                 AND acked = 0
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at >= ?`;
  const info = db.query(sql).run(...req.lease_tokens, req.id, req.session_token, nowIso());
  return { ok: true, acked: info.changes ?? 0 };
}

// ----- Rename -----

export function renamePeer(db: Database, req: RenamePeerRequest): RenamePeerResponse {
  if (!isValidName(req.new_name)) return { ok: false, error: "invalid name" };
  // Atomic auth + rename: session_token is bound in the WHERE, so a
  // reclaim-rotated row is unchangeable by a stale session. Zero changes
  // means either the peer_id is unknown OR the session_token is wrong;
  // we return "unauthorized rename" in both cases (no auth-vs-enumeration
  // leak).
  try {
    const info = db.query(
      "UPDATE peers SET name = ?, last_seen = ? WHERE id = ? AND session_token = ?"
    ).run(req.new_name, nowIso(), req.id, req.session_token);
    if ((info.changes ?? 0) === 0) return { ok: false, error: "unauthorized rename" };
    return { ok: true, name: req.new_name };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "name taken" };
    throw e;
  }
}

// NOTE: there is no broker-side "admin rename" function. cli.ts 'rename'
// reads the target peer's session_token directly from the SQLite file
// (SELECT id, session_token FROM peers WHERE id=? OR name=?) and then calls
// the regular session-authenticated /rename-peer. The OS file permissions on
// ~/.agent-peers.db are the operator trust boundary — only the user who owns
// the file can run the CLI's admin rename.

// ----- GC -----

export function gcStalePeers(db: Database): number {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const info = db.query("DELETE FROM peers WHERE last_seen < ?").run(cutoff);
  return info.changes ?? 0;
}

// ----- Orphans -----

export interface OrphanMessage {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
}

export function listOrphanedMessages(db: Database): OrphanMessage[] {
  return db.query<OrphanMessage, []>(
    `SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at
     FROM messages m
     LEFT JOIN peers p ON p.id = m.to_id
     WHERE p.id IS NULL AND m.acked = 0
     ORDER BY m.id ASC`
  ).all();
}

// Diagnostic view of every row in messages (acked + unacked), enriched with
// sender/recipient names so a user can answer "did Claude's message actually
// reach Codex's mailbox?" without guessing. Used by `cli.ts messages`.
//
// Status semantics exposed to the CLI so operators can read them at a glance:
//   - acked=1                      → ACKED (delivered + acknowledged)
//   - acked=0, active lease        → LEASED (currently in a recipient's poll
//                                    buffer, lease still valid)
//   - acked=0, no/expired lease    → PENDING (ready to be picked up on next poll)
export interface InspectMessage {
  id: number;
  from_id: string;
  from_name: string | null;
  to_id: string;
  to_name: string | null;
  text: string;
  sent_at: string;
  acked: number;
  active_lease: number;   // 1 iff lease_token present AND lease_expires_at >= now()
  lease_expires_at: string | null;
}

export function listAllMessages(
  db: Database,
  opts: { limit?: number; order?: "DESC" | "ASC" } = {},
): { messages: InspectMessage[]; truncated: boolean; total_rows: number } {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
  const order = opts.order === "ASC" ? "ASC" : "DESC";
  const nowStr = nowIso();
  const total = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()?.c ?? 0;
  const rows = db.query<InspectMessage, [string]>(
    `SELECT m.id,
            m.from_id,
            pf.name AS from_name,
            m.to_id,
            pt.name AS to_name,
            m.text,
            m.sent_at,
            m.acked,
            CASE
              WHEN m.lease_token IS NOT NULL
                   AND m.lease_expires_at IS NOT NULL
                   AND m.lease_expires_at >= ?
              THEN 1 ELSE 0
            END AS active_lease,
            m.lease_expires_at
     FROM messages m
     LEFT JOIN peers pf ON pf.id = m.from_id
     LEFT JOIN peers pt ON pt.id = m.to_id
     ORDER BY m.id ${order}
     LIMIT ${limit}`
  ).all(nowStr);
  return { messages: rows, truncated: rows.length < total, total_rows: total };
}

// ----- HTTP -----

async function readJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

// Per-user shared secret. Generated on first broker startup, written to
// ~/.agent-peers-secret with mode 0600 so only the owning OS user can read
// it. Every broker HTTP request must carry the secret in the
// X-Agent-Peers-Secret header; /health is the sole exception (liveness
// probe). This closes the "any local process can enumerate peers / inject
// messages" gap that mere localhost binding does not solve on shared or
// multi-user hosts.
export function ensureSharedSecret(path: string): string {
  // Crash-safe atomic provisioning (Codex round-E fix for "ensureSharedSecret
  // bricks startup after a crash between create and write"):
  //
  //   1. If path already exists, validate its perms (same checks as client),
  //      then check content length. If valid and length >= 32, reuse it.
  //      If the file exists but is short/empty (partial-write from a crashed
  //      earlier broker), refuse to act — throw with a clear recovery
  //      instruction. Auto-repair would race with concurrent brokers.
  //   2. Otherwise, write the secret to a PID-suffixed temp file, fsync it,
  //      chmod 0600, then attempt an atomic linkSync to the final path.
  //      link() succeeds only if the final path does NOT exist — two
  //      concurrent brokers racing here both tmpfile-write, only one wins
  //      the link, the loser reads the winner's content.
  //   3. After link, unlink the temp file. If link failed with EEXIST,
  //      someone else got there — delete our temp, read whatever they wrote.

  // Fast path: validated existing file
  if (existsSync(path)) {
    validateSecretFilePerms(path);
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
    throw new Error(
      `broker: shared-secret file at ${path} exists but is too short (${existing.length} chars) — likely a partial write from a crashed broker. ` +
      `To recover: stop all brokers, delete ${path}, and restart.`
    );
  }

  const secret = randomUUID() + randomUUID().replace(/-/g, "");
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;

  // Write secret to unique temp path, fsync, chmod 0600.
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, secret + "\n");
    try { fsyncSync(fd); } catch { /* best effort on fs that doesn't support fsync */ }
  } finally {
    closeSync(fd);
  }
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }

  // Try atomic link: succeeds only if `path` doesn't exist yet. This gives
  // us exclusive-create semantics without the torn-write window of O_EXCL.
  // On filesystems without hard-link support (FAT/exFAT/some network fs)
  // linkSync fails with ENOTSUP/EPERM — fall back to openSync('wx') on the
  // target path (Codex round-F fix). That's still race-safe because O_EXCL
  // is atomic; the only property we lose is crash-resilience against torn
  // writes. Rare + non-fatal.
  let linked = false;
  try {
    linkSync(tmp, path);
    linked = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/EEXIST/.test(msg)) {
      // Someone else linked first. Fall through to read their content.
    } else if (/ENOTSUP|EPERM|EOPNOTSUPP/i.test(msg)) {
      // Hard links not supported on this filesystem — fall back to an
      // exclusive-create open on the target path itself.
      try {
        const fd2 = openSync(path, "wx", 0o600);
        try {
          writeSync(fd2, secret + "\n");
          try { fsyncSync(fd2); } catch { /* best effort */ }
        } finally {
          closeSync(fd2);
        }
        try { chmodSync(path, 0o600); } catch { /* best effort */ }
        linked = true;
      } catch (e2: unknown) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        if (!/EEXIST/.test(msg2)) {
          try { unlinkSync(tmp); } catch { /* best effort */ }
          throw e2;
        }
        // EEXIST on fallback too — someone else got there.
      }
    } else {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }

  if (linked) {
    // Verify our write survived the link.
    const back = readFileSync(path, "utf8").trim();
    if (back === secret) return secret;
    // If something else wrote after us (shouldn't happen with link), fall through
  }

  // Read whoever won the link-race (or us, post-hoc).
  validateSecretFilePerms(path);
  const persisted = readFileSync(path, "utf8").trim();
  if (persisted.length < 32) {
    throw new Error(`broker: shared-secret file at ${path} is too short after link — unrecoverable`);
  }
  return persisted;
}

export function startBroker(port: number, dbPath: string, secretPath = DEFAULT_SECRET_PATH) {
  const db = initDb(dbPath);
  const sharedSecret = ensureSharedSecret(secretPath);

  const gcTimer = setInterval(() => {
    try { gcStalePeers(db); } catch (e) { console.error("[broker] GC error:", e); }
    // Re-enforce 0600 on WAL/SHM sidecars — SQLite may recreate them on
    // checkpoint, and they'd come back with default umask-controlled perms.
    chmodIfExists(dbPath + "-wal", 0o600);
    chmodIfExists(dbPath + "-shm", 0o600);
  }, GC_INTERVAL_MS);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return json({ ok: true, pid: process.pid });
        }
        if (req.method !== "POST") return json({ error: "method not allowed" }, { status: 405 });

        // Shared-secret gate for every non-/health request.
        const presented = req.headers.get(SECRET_HEADER);
        if (presented !== sharedSecret) {
          return json({ error: "missing or invalid " + SECRET_HEADER }, { status: 401 });
        }

        switch (url.pathname) {
          case "/register":      return json(registerPeer(db, await readJson(req)));
          case "/heartbeat":     { const b = await readJson<{ id: string; session_token: string }>(req); heartbeatPeer(db, b.id, b.session_token); return json({ ok: true }); }
          case "/unregister":    { const b = await readJson<{ id: string; session_token: string }>(req); unregisterPeer(db, b.id, b.session_token); return json({ ok: true }); }
          case "/set-summary":   { const b = await readJson<{ id: string; session_token: string; summary: string }>(req); setPeerSummary(db, b.id, b.session_token, b.summary); return json({ ok: true }); }
          case "/list-peers":    return json(listPeers(db, await readJson(req)));
          case "/send-message":  return json(sendMessage(db, await readJson(req)));
          case "/poll-messages": { const b = await readJson<{ id: string; session_token: string }>(req); return json({ messages: pollMessages(db, b.id, b.session_token) }); }
          case "/ack-messages":  return json(ackMessages(db, await readJson(req)));
          case "/rename-peer":   return json(renamePeer(db, await readJson(req)));
          // No /admin/rename-peer over HTTP — arbitrary local processes could
          // hijack any peer's name. cli.ts 'rename' reads the target peer's
          // session_token from SQLite directly (file perms = trust boundary)
          // and then calls the normal session-authenticated /rename-peer.
          // No /orphaned-messages over HTTP — exposing bodies over localhost
          // leaks peer traffic. cli.ts 'orphaned-messages' opens SQLite readonly.
          // No /all-messages endpoint — same reasoning.
          default: return json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        console.error("[broker] request error:", e);
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    },
  });

  const cleanup = () => {
    clearInterval(gcTimer);
    server.stop(true);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.error(`[broker] listening on http://127.0.0.1:${port}, db=${dbPath}, pid=${process.pid}`);
  return { server, db, gcTimer };
}

// Re-exports for consumers.
export { NAME_REGEX, NAME_MAX_LEN, isValidName };

if (import.meta.main) {
  startBroker(DEFAULT_PORT, process.env.AGENT_PEERS_DB || DEFAULT_DB_PATH);
}
