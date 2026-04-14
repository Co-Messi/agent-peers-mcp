#!/usr/bin/env bun
// broker.ts
// HTTP + SQLite daemon for agent-peers-mcp. Runs on localhost:7900.
// Spec: docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RegisterRequest, RegisterResponse, Peer,
  ListPeersRequest, SendMessageRequest, SendMessageResponse,
  LeasedMessage, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
} from "./shared/types.ts";
import { generateName, isValidName, NAME_MAX_LEN, NAME_REGEX } from "./shared/names.ts";

export const DEFAULT_DB_PATH = resolve(homedir(), ".agent-peers.db");
export const DEFAULT_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
export const STALE_THRESHOLD_MS = 60_000;
export const STALE_RECLAIM_THRESHOLD_MS = 60_000;
export const LEASE_DURATION_MS = 30_000;
export const GC_INTERVAL_MS = 30_000;

function nowIso(): string { return new Date().toISOString(); }

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

// ----- Schema -----

export function initDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

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

// Returns true if (id, session_token) matches a row. Core auth primitive.
function authPeer(db: Database, id: string, session_token: string): boolean {
  const row = db.query<{ c: number }, [string, string]>(
    "SELECT COUNT(*) AS c FROM peers WHERE id = ? AND session_token = ?"
  ).get(id, session_token);
  return (row?.c ?? 0) > 0;
}

// heartbeat/unregister/setSummary are peer-authenticated. Token mismatch
// silently no-ops (we don't leak "wrong token" vs "unknown peer"; both look
// like a missing row to the caller).

export function heartbeatPeer(db: Database, id: string, session_token: string): void {
  if (!authPeer(db, id, session_token)) return;
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(nowIso(), id);
}

export function unregisterPeer(db: Database, id: string, session_token: string): void {
  if (!authPeer(db, id, session_token)) return;
  // Messages stay as orphans (spec §5.1).
  db.query("DELETE FROM peers WHERE id = ?").run(id);
}

export function setPeerSummary(db: Database, id: string, session_token: string, summary: string): void {
  if (!authPeer(db, id, session_token)) return;
  db.query("UPDATE peers SET summary = ?, last_seen = ? WHERE id = ?").run(summary, nowIso(), id);
}

export function getPeer(db: Database, id: string): Peer | null {
  const row = db.query<Peer, [string]>("SELECT * FROM peers WHERE id = ?").get(id);
  return row ?? null;
}

export function getPeerByName(db: Database, name: string): Peer | null {
  const row = db.query<Peer, [string]>("SELECT * FROM peers WHERE name = ?").get(name);
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

  const where = `WHERE ${clauses.join(" AND ")}`;
  const sql = `SELECT * FROM peers ${where} ORDER BY last_seen DESC`;
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
  // Sender identity validation via session_token — reject forged senders.
  if (!authPeer(db, req.from_id, req.session_token)) {
    return { ok: false, error: `unauthorized sender: ${req.from_id}` };
  }
  const sender = getPeer(db, req.from_id);
  if (!sender) return { ok: false, error: `unknown sender: ${req.from_id}` };
  if (isStale(sender.last_seen)) return { ok: false, error: `sender stale: ${sender.name}` };

  const target = resolveTarget(db, req.to_id_or_name);
  if (!target) return { ok: false, error: `unknown peer: ${req.to_id_or_name}` };
  if (isStale(target.last_seen)) return { ok: false, error: `target peer stale: ${target.name}` };

  const result = db.query<{ id: number }, [string, string, string, string]>(
    `INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?) RETURNING id`
  ).get(req.from_id, target.id, req.text, nowIso());

  return { ok: true, message_id: result?.id };
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
  // Session-token auth — caller must prove peer ownership.
  if (!authPeer(db, req.id, req.session_token)) return { ok: true, acked: 0 };

  const placeholders = req.lease_tokens.map(() => "?").join(",");
  const sql = `UPDATE messages SET acked = 1, lease_token = NULL, lease_expires_at = NULL
               WHERE lease_token IN (${placeholders})
                 AND to_id = ?
                 AND acked = 0
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at >= ?`;
  const info = db.query(sql).run(...req.lease_tokens, req.id, nowIso());
  return { ok: true, acked: info.changes ?? 0 };
}

// ----- Rename -----

export function renamePeer(db: Database, req: RenamePeerRequest): RenamePeerResponse {
  if (!isValidName(req.new_name)) return { ok: false, error: "invalid name" };
  // Session-token auth — only the peer itself can rename itself via this path.
  if (!authPeer(db, req.id, req.session_token)) {
    return { ok: false, error: "unauthorized rename" };
  }
  try {
    const info = db.query("UPDATE peers SET name = ?, last_seen = ? WHERE id = ?")
      .run(req.new_name, nowIso(), req.id);
    if ((info.changes ?? 0) === 0) return { ok: false, error: "unknown peer" };
    return { ok: true, name: req.new_name };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "name taken" };
    throw e;
  }
}

// Admin variant — no token check. Used by cli.ts only. The trust boundary is
// the broker's 127.0.0.1 binding: if you can hit this endpoint, you are
// already a local-machine operator.
export function adminRenamePeer(
  db: Database,
  req: { id: string; new_name: string },
): RenamePeerResponse {
  if (!isValidName(req.new_name)) return { ok: false, error: "invalid name" };
  try {
    const info = db.query("UPDATE peers SET name = ?, last_seen = ? WHERE id = ?")
      .run(req.new_name, nowIso(), req.id);
    if ((info.changes ?? 0) === 0) return { ok: false, error: "unknown peer" };
    return { ok: true, name: req.new_name };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "name taken" };
    throw e;
  }
}

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
export interface InspectMessage {
  id: number;
  from_id: string;
  from_name: string | null;
  to_id: string;
  to_name: string | null;
  text: string;
  sent_at: string;
  acked: number;
  has_lease: number;
  lease_expires_at: string | null;
}

export function listAllMessages(db: Database): InspectMessage[] {
  return db.query<InspectMessage, []>(
    `SELECT m.id,
            m.from_id,
            pf.name AS from_name,
            m.to_id,
            pt.name AS to_name,
            m.text,
            m.sent_at,
            m.acked,
            CASE WHEN m.lease_token IS NULL THEN 0 ELSE 1 END AS has_lease,
            m.lease_expires_at
     FROM messages m
     LEFT JOIN peers pf ON pf.id = m.from_id
     LEFT JOIN peers pt ON pt.id = m.to_id
     ORDER BY m.id DESC
     LIMIT 100`
  ).all();
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

export function startBroker(port: number, dbPath: string) {
  const db = initDb(dbPath);

  const gcTimer = setInterval(() => {
    try { gcStalePeers(db); } catch (e) { console.error("[broker] GC error:", e); }
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
          case "/admin/rename-peer": return json(adminRenamePeer(db, await readJson(req)));
          case "/orphaned-messages": return json({ messages: listOrphanedMessages(db) });
          case "/all-messages": return json({ messages: listAllMessages(db) });
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
