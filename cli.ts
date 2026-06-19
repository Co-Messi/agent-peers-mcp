#!/usr/bin/env bun
// cli.ts
// Inspection + admin CLI for agent-peers-mcp. Talks to broker on :7900.

import { createClient } from "./shared/broker-client.ts";
import { readSharedSecret } from "./shared/shared-secret.ts";
import { sanitizeTerminalText as safe } from "./shared/safe-output.ts";
import { parsePort } from "./shared/config.ts";
import { WakeRegistry, hashBrokerSessionToken } from "./shared/wake-registry.ts";
import { WakeLaunchClaimStore } from "./shared/wake-launch-claims.ts";
import type { Peer } from "./shared/types.ts";

const BROKER_PORT = parsePort(process.env.AGENT_PEERS_PORT, 7900);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// Read the shared secret. Commands that hit the broker's HTTP API (status,
// peers, send, set-summary) require the secret. Direct-SQLite commands
// (rename, messages, orphaned-messages) and `kill-broker` don't — those are
// gated by OS file permissions on the DB + secret files.
const sharedSecret = readSharedSecret();
const client = createClient(BROKER_URL, sharedSecret ?? "");

interface PeerAuthRow {
  id: string;
  session_token: string;
  name: string;
  peer_type: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
}

async function readPeerAuth(target: string): Promise<PeerAuthRow | null> {
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<PeerAuthRow, [string, string]>(
      `SELECT id, session_token, name, peer_type, pid, cwd, git_root, tty
       FROM peers
       WHERE id = ? OR name = ?`
    ).get(target, target) ?? null;
  } finally {
    db.close();
  }
}

async function readUnreadCountsByPeer(): Promise<Map<string, number>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const rootDir = process.env.AGENT_PEERS_CODEX_STATE_DIR ?? join(homedir(), ".agent-peers-codex");
  const counts = new Map<string, number>();
  let files: string[];
  try {
    files = await readdir(rootDir);
  } catch {
    return counts;
  }

  for (const file of files) {
    if (!file.endsWith(".metadata.json")) continue;
    try {
      const raw = await readFile(join(rootDir, file), "utf8");
      const parsed = JSON.parse(raw) as { unread?: unknown[] };
      const peerId = decodeURIComponent(file.slice(0, -".metadata.json".length));
      counts.set(peerId, Array.isArray(parsed.unread) ? parsed.unread.length : 0);
    } catch {
      /* ignore malformed metadata */
    }
  }
  return counts;
}

async function cmdStatus() {
  const alive = await client.isAlive();
  if (!alive) {
    console.log(`broker: not running on ${BROKER_URL}`);
    process.exit(1);
  }
  console.log(`broker: running on ${BROKER_URL}`);
  const diagnostics = await client.diagnostics();
  console.log(
    `queues: peers=${diagnostics.peers} pending=${diagnostics.pending_messages} ` +
    `leased=${diagnostics.leased_messages} acked-retained=${diagnostics.acknowledged_messages} ` +
    `orphans=${diagnostics.orphaned_messages}`,
  );
  await cmdPeers();
  console.log("");
  await cmdWakeStatus();
}

async function cmdPeers() {
  const peers = await client.listPeers({
    scope: "machine", cwd: process.cwd(), git_root: null,
  });
  if (peers.length === 0) {
    console.log("(no peers registered)");
    return;
  }
  for (const p of peers) {
    console.log(`${safe(p.name, 32)}  (${p.peer_type})  id=${safe(p.id, 128)}`);
    console.log(`  cwd=${safe(p.cwd)}${p.tty ? `  tty=${safe(p.tty, 256)}` : ""}`);
    if (p.summary) console.log(`  summary: ${safe(p.summary, 1024)}`);
    console.log(`  last_seen=${p.last_seen}`);
  }
}

async function cmdSend(targetNameOrId: string, message: string) {
  // The broker now requires from_id to resolve to a registered, live peer
  // (current lifecycle invariant). Register a short-lived operator peer for this
  // send, then unregister it. Name is unique via PID suffix.
  const operatorName = `cli-operator-${process.pid}`;
  const reg = await client.register({
    peer_type: "claude",
    name: operatorName,
    pid: process.pid,
    cwd: process.cwd(),
    git_root: null,
    tty: null,
    summary: "local CLI operator",
  });
  // Lifecycle invariant: do NOT call process.exit() inside the try — that
  // terminates the process before finally runs and leaves the operator peer
  // registered. Capture the exit status, always unregister, then exit.
  let exitCode = 0;
  let sendError: string | null = null;
  let messageId: number | undefined;
  try {
    const res = await client.sendMessage({
      from_id: reg.id, session_token: reg.session_token, to_id_or_name: targetNameOrId, text: message,
    });
    if (!res.ok) {
      sendError = res.error ?? "unknown";
      exitCode = 1;
    } else {
      messageId = res.message_id;
    }
  } finally {
    try {
      await client.unregister({ id: reg.id, session_token: reg.session_token });
    } catch {
      /* best effort */
    }
  }
  if (exitCode !== 0) {
    console.error(`send failed: ${sendError}`);
    process.exit(exitCode);
  }
  console.log(`sent (id=${messageId}, from=${reg.name})`);
}

async function cmdRename(target: string, newName: string) {
  // Read the target peer's session_token from the SQLite file directly — the
  // operator trust boundary is OS file permissions on ~/.agent-peers.db,
  // NOT an unauthenticated HTTP admin endpoint. The security model excludes the
  // /admin/rename-peer HTTP endpoint because any local process could have
  // hijacked peer identities.
  const row = await readPeerAuth(target);
  if (!row) {
    console.error(`no peer matching '${target}'`);
    process.exit(1);
  }
  // Call the regular session-authenticated /rename-peer, impersonating the
  // peer with its own token that we just read from the DB.
  const res = await client.renamePeer({
    id: row.id, session_token: row.session_token, new_name: newName,
  });
  if (!res.ok) {
    console.error(`rename failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`renamed ${row.name} -> ${res.name}`);
}

async function cmdRetire(target: string) {
  // Operator-side graceful shutdown: remove the peer from broker discovery and
  // remove any wake registry row for this exact peer id. Message history stays
  // in the broker; inbox files are deliberately left alone.
  const row = await readPeerAuth(target);
  if (!row) {
    const registry = new WakeRegistry();
    await registry.init();
    const entry = (await registry.list({ includeStale: true }))
      .find((candidate) => candidate.peer_id === target || candidate.peer_name === target);
    if (!entry) {
      console.error(`no peer or wake registry entry matching '${target}'`);
      process.exit(1);
    }
    await registry.removeByPeerId(entry.peer_id);
    console.log(`retired stale wake entry ${entry.peer_name} (${entry.peer_id})`);
    console.log("  broker row was already missing");
    return;
  }

  await client.unregister({ id: row.id, session_token: row.session_token });

  const registry = new WakeRegistry();
  await registry.init();
  await registry.removeByPeerId(row.id);

  console.log(`retired ${row.name} (${row.id})`);
  console.log("  removed from broker discovery and wake registry");
  console.log("  message history and local inbox files were preserved");
}

async function cmdRepairWake(target: string) {
  const row = await readPeerAuth(target);
  if (!row) {
    console.error(`no peer matching '${target}'`);
    process.exit(1);
  }
  if (row.peer_type !== "codex") {
    console.error(`peer '${row.name}' is ${row.peer_type}, not codex`);
    process.exit(1);
  }

  const claimStore = new WakeLaunchClaimStore();
  const candidates = await claimStore.listMatchingCandidates({
    cwd: row.cwd,
    tty: row.tty,
    includeConsumed: true,
    requestedPeerName: row.name,
  });
  if (candidates.length === 0) {
    console.error(`no live wake launch claim found for ${row.name} (cwd=${row.cwd}${row.tty ? ` tty=${row.tty}` : ""})`);
    process.exit(1);
  }

  // Ambiguity guard: if two or more *live* sessions with DISTINCT threads match
  // this cwd/tty, we cannot safely tell which one belongs to this peer — wiring
  // the wake pointer to the wrong thread would wake the wrong session. Refuse
  // and tell the operator to retire the stragglers first. (This is the
  // same-repo / null-tty Zed case where cwd+tty alone can't disambiguate.)
  const liveThreads = new Set(candidates.filter((c) => c.live).map((c) => c.thread_id));
  if (liveThreads.size > 1) {
    console.error(`ambiguous wake claims for ${row.name}: ${liveThreads.size} live sessions share cwd=${row.cwd}${row.tty ? ` tty=${row.tty}` : ""}`);
    for (const c of candidates.filter((c) => c.live)) {
      console.error(`  thread=${c.thread_id}  app_server=${c.app_server_url}  app_server_pid=${c.app_server_pid}`);
    }
    console.error("refusing to guess. Retire the session(s) you don't want with `codex-peer retire <name-or-id>`, then retry repair-wake.");
    process.exit(1);
  }

  // Prefer a live candidate; fall back to the newest complete claim.
  const claim = candidates.find((c) => c.live) ?? candidates[0]!;

  const now = new Date().toISOString();
  const registry = new WakeRegistry();
  await registry.init();
  await registry.upsert({
    peer_id: row.id,
    peer_name: row.name,
    cwd: row.cwd,
    git_root: row.git_root,
    tty: row.tty,
    thread_id: claim.thread_id,
    rollout_path: claim.rollout_path,
    app_server_url: claim.app_server_url,
    app_server_socket_path: claim.app_server_socket_path,
    app_server_pid: claim.app_server_pid,
    tui_pid: claim.tui_pid,
    mcp_pid: row.pid,
    broker_session_token_hash: hashBrokerSessionToken(row.session_token),
    status: "ready",
    capabilities: ["app-server-ws"],
    created_at: claim.created_at,
    updated_at: now,
    last_seen_at: now,
  });
  await claimStore.consume(claim.claim_id, row.id).catch(() => {});

  console.log(`repaired wake registry for ${row.name} (${row.id})`);
  console.log(`  thread=${claim.thread_id}`);
  console.log(`  app_server=${claim.app_server_url}`);
}

async function cmdWakeStatus() {
  const peers = await client.listPeers({
    scope: "machine", cwd: process.cwd(), git_root: null,
  });
  const codexPeers = peers.filter((peer) => peer.peer_type === "codex");

  const registry = new WakeRegistry();
  await registry.init();
  const registryEntries = await registry.list({ includeStale: true });
  const registryByPeerId = new Map(registryEntries.map((entry) => [entry.peer_id, entry]));
  const unreadCounts = await readUnreadCountsByPeer();

  if (codexPeers.length === 0 && registryEntries.length === 0) {
    console.log("wakeable codex: no live Codex peers or wake registry entries");
    return;
  }

  const rows = codexPeers.sort(comparePeers).map((peer) => ({
    peer,
    entry: registryByPeerId.get(peer.id),
    pending: unreadCounts.get(peer.id) ?? 0,
  }));
  const wakeableRows = rows.filter((row) => row.entry?.status === "ready");
  const needsRepairRows = rows.filter((row) =>
    !row.entry && /(?:^|-)codex(?:-\d+)?$/.test(row.peer.name)
  );
  const otherRows = rows.filter((row) =>
    !wakeableRows.includes(row) && !needsRepairRows.includes(row)
  );

  console.log("wakeable Codex sessions:");
  if (wakeableRows.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of wakeableRows) printWakePeer(row.peer, row.entry, row.pending);
  }

  if (needsRepairRows.length > 0) {
    console.log("");
    console.log("Codex peers that look like wakeable launches but need repair:");
    for (const row of needsRepairRows) printWakePeer(row.peer, row.entry, row.pending);
  }

  if (otherRows.length > 0) {
    console.log("");
    console.log("Other live Codex peers:");
    for (const row of otherRows) printWakePeer(row.peer, row.entry, row.pending);
  }

  const liveIds = new Set(codexPeers.map((peer) => peer.id));
  const registryOnly = registryEntries.filter((entry) => !liveIds.has(entry.peer_id));
  if (registryOnly.length > 0) {
    console.log("");
    console.log("Stale or registry-only wake entries:");
    for (const entry of registryOnly) {
      const pending = unreadCounts.get(entry.peer_id) ?? 0;
      console.log(`  ${entry.peer_name}  broker=missing  wakeable=${entry.status === "ready" ? "registry-only" : `no (${entry.status})`}  unread=${pending}  id=${entry.peer_id}`);
      console.log(`    cwd=${entry.cwd}${entry.tty ? `  tty=${entry.tty}` : ""}`);
      console.log(`    thread=${entry.thread_id}  app_server_pid=${entry.app_server_pid}  mcp_pid=${entry.mcp_pid}${entry.tui_pid ? `  tui_pid=${entry.tui_pid}` : ""}`);
    }
  }

  if (needsRepairRows.length > 0) {
    console.log("");
    console.log("tip: run codex-peer repair-wake <name-or-id> for any live Codex peer that should be wakeable.");
    console.log("     run codex-peer retire <name-or-id> to remove stale/confusing names from discovery.");
  }
}

function printWakePeer(peer: Peer, entry: Awaited<ReturnType<WakeRegistry["list"]>>[number] | undefined, pending: number): void {
  const wakeable = entry ? (entry.status === "ready" ? "yes" : `no (${entry.status})`) : "no";
  console.log(`  ${peer.name}  wakeable=${wakeable}  unread=${pending}  id=${peer.id}`);
  console.log(`    cwd=${peer.cwd}${peer.tty ? `  tty=${peer.tty}` : ""}`);
  if (entry) {
    console.log(`    thread=${entry.thread_id}  app_server_pid=${entry.app_server_pid}  mcp_pid=${entry.mcp_pid}${entry.tui_pid ? `  tui_pid=${entry.tui_pid}` : ""}`);
  }
  if (peer.summary) console.log(`    summary: ${peer.summary}`);
}

function comparePeers(a: Peer, b: Peer): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

async function cmdMessages() {
  // Read the SQLite DB directly so OS file permissions remain the trust
  // boundary. The broker deliberately does NOT expose message bodies over an
  // unauthenticated HTTP endpoint (any local process can reach 127.0.0.1).
  // The filesystem is the trust boundary.
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const nowStr = new Date().toISOString();
    const total =
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()?.c ?? 0;
    const LIMIT = 500;
    type Row = {
      id: number;
      from_id: string;
      from_name: string | null;
      to_id: string;
      to_name: string | null;
      text: string;
      sent_at: string;
      acked: number;
      active_lease: number;
      lease_expires_at: string | null;
    };
    const rows = db.query<Row, [string]>(
      `SELECT m.id, m.from_id, pf.name AS from_name, m.to_id, pt.name AS to_name,
              m.text, m.sent_at, m.acked,
              CASE WHEN m.lease_token IS NOT NULL
                        AND m.lease_expires_at IS NOT NULL
                        AND m.lease_expires_at >= ?
                   THEN 1 ELSE 0 END AS active_lease,
              m.lease_expires_at
       FROM messages m
       LEFT JOIN peers pf ON pf.id = m.from_id
       LEFT JOIN peers pt ON pt.id = m.to_id
       ORDER BY m.id DESC
       LIMIT ${LIMIT}`
    ).all(nowStr);

    if (rows.length === 0) {
      console.log("(no messages in broker)");
      return;
    }
    if (rows.length < total) {
      console.log(`Showing newest ${rows.length} of ${total} message(s) (truncated — use 'sqlite3' directly for the full set):\n`);
    } else {
      console.log(`${rows.length} message(s) in broker (newest first):\n`);
    }
    for (const m of rows) {
      const status = m.acked ? "ACKED" : m.active_lease ? "LEASED" : "PENDING";
      const from = m.from_name ?? `(gone: ${m.from_id.slice(0, 8)}…)`;
      const to = m.to_name ?? `(gone: ${m.to_id.slice(0, 8)}…)`;
      const preview = m.text.length > 80 ? m.text.slice(0, 77) + "..." : m.text;
      console.log(`#${m.id}  ${status}  from=${from}  to=${to}  sent=${m.sent_at}`);
      if (m.active_lease && m.lease_expires_at) console.log(`  lease_expires=${m.lease_expires_at}`);
      console.log(`  ${safe(preview, 80)}`);
      console.log("");
    }
  } finally {
    db.close();
  }
}

async function cmdOrphans() {
  // Read the SQLite DB directly — OS file permissions are the trust boundary.
  // The security model excludes the /orphaned-messages HTTP endpoint because it
  // leaked message bodies to any local process on 127.0.0.1.
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    type Row = { id: number; from_id: string; to_id: string; text: string; sent_at: string };
    const rows = db.query<Row, []>(
      `SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at
       FROM messages m
       LEFT JOIN peers p ON p.id = m.to_id
       WHERE p.id IS NULL AND m.acked = 0
       ORDER BY m.id ASC`
    ).all();
    if (rows.length === 0) {
      console.log("(no orphaned messages)");
      return;
    }
    for (const m of rows) {
      const preview = m.text.length > 80 ? m.text.slice(0, 77) + "..." : m.text;
      console.log(`#${m.id}  from=${m.from_id}  to=${m.to_id}  sent=${m.sent_at}`);
      console.log(`  ${safe(preview, 80)}`);
    }
  } finally {
    db.close();
  }
}

async function cmdKillBroker() {
  if (!sharedSecret) {
    console.error("cannot authenticate broker: shared secret is unavailable");
    process.exitCode = 1;
    return;
  }
  const health = await client.health();
  if (!health) {
    console.log("broker not running");
    return;
  }
  try {
    process.kill(health.pid, "SIGTERM");
    console.log(`killed authenticated broker pid=${health.pid}`);
  } catch (e) {
    console.error(`kill ${health.pid} failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

async function cmdPurge() {
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const { purgeExpiredMessages } = await import("./broker.ts");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath);
  try {
    const result = purgeExpiredMessages(db);
    console.log(`purged acknowledged=${result.acked} orphaned=${result.orphaned}`);
  } finally {
    db.close();
  }
}

const [, , sub, ...rest] = process.argv;
switch (sub) {
  case "status":
    await cmdStatus();
    break;
  case "peers":
    await cmdPeers();
    break;
  case "wake-status":
  case "live":
    await cmdWakeStatus();
    break;
  case "send":
    if (rest.length < 2) {
      console.error("usage: cli.ts send <name-or-id> <message>");
      process.exit(2);
    }
    await cmdSend(rest[0]!, rest.slice(1).join(" "));
    break;
  case "rename":
    if (rest.length !== 2) {
      console.error("usage: cli.ts rename <name-or-id> <new-name>");
      process.exit(2);
    }
    await cmdRename(rest[0]!, rest[1]!);
    break;
  case "retire":
  case "unregister":
    if (rest.length !== 1) {
      console.error("usage: cli.ts retire <name-or-id>");
      process.exit(2);
    }
    await cmdRetire(rest[0]!);
    break;
  case "repair-wake":
  case "attach-wake":
    if (rest.length !== 1) {
      console.error("usage: cli.ts repair-wake <name-or-id>");
      process.exit(2);
    }
    await cmdRepairWake(rest[0]!);
    break;
  case "messages":
    await cmdMessages();
    break;
  case "orphaned-messages":
    await cmdOrphans();
    break;
  case "kill-broker":
    await cmdKillBroker();
    break;
  case "purge":
    await cmdPurge();
    break;
  default:
    console.log(`usage:
  bun cli.ts status
  bun cli.ts peers
  bun cli.ts wake-status
  bun cli.ts send <name-or-id> <message>
  bun cli.ts rename <name-or-id> <new-name>
  bun cli.ts retire <name-or-id>
  bun cli.ts repair-wake <name-or-id>
  bun cli.ts messages
  bun cli.ts orphaned-messages
  bun cli.ts purge
  bun cli.ts kill-broker`);
    process.exit(sub ? 2 : 0);
}
