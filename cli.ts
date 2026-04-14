#!/usr/bin/env bun
// cli.ts
// Inspection + admin CLI for agent-peers-mcp. Talks to broker on :7900.

import { createClient } from "./shared/broker-client.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const client = createClient(BROKER_URL);

async function cmdStatus() {
  const alive = await client.isAlive();
  if (!alive) {
    console.log(`broker: not running on ${BROKER_URL}`);
    process.exit(1);
  }
  console.log(`broker: running on ${BROKER_URL}`);
  await cmdPeers();
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
    console.log(`${p.name}  (${p.peer_type})  id=${p.id}`);
    console.log(`  cwd=${p.cwd}${p.tty ? `  tty=${p.tty}` : ""}`);
    if (p.summary) console.log(`  summary: ${p.summary}`);
    console.log(`  last_seen=${p.last_seen}`);
  }
}

async function cmdSend(targetNameOrId: string, message: string) {
  // The broker now requires from_id to resolve to a registered, live peer
  // (code review round-1 fix). Register a short-lived operator peer for this
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
  // Code review round-2 fix: do NOT call process.exit() inside the try — that
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
  // NOT an unauthenticated HTTP admin endpoint. Round-B audit removed the
  // /admin/rename-peer HTTP endpoint because any local process could have
  // hijacked peer identities.
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  let row: { id: string; session_token: string; name: string } | null;
  try {
    row = db.query<{ id: string; session_token: string; name: string }, [string, string]>(
      "SELECT id, session_token, name FROM peers WHERE id = ? OR name = ?"
    ).get(target, target);
  } finally {
    db.close();
  }
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

async function cmdMessages() {
  // Read the SQLite DB directly so OS file permissions remain the trust
  // boundary. The broker deliberately does NOT expose message bodies over an
  // unauthenticated HTTP endpoint (any local process can reach 127.0.0.1).
  // Round-A security fix.
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
      console.log(`  ${preview}`);
      console.log("");
    }
  } finally {
    db.close();
  }
}

async function cmdOrphans() {
  // Read the SQLite DB directly — OS file permissions are the trust boundary.
  // Round-B fix: removed the /orphaned-messages HTTP endpoint because it
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
      console.log(`  ${preview}`);
    }
  } finally {
    db.close();
  }
}

async function cmdKillBroker() {
  const proc = Bun.spawn(["lsof", "-t", "-i", `:${BROKER_PORT}`], {
    stdout: "pipe", stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) {
    console.log("broker not running");
    return;
  }
  for (const pid of out.split("\n")) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`killed pid=${pid}`);
    } catch (e) {
      console.error(`kill ${pid} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  case "messages":
    await cmdMessages();
    break;
  case "orphaned-messages":
    await cmdOrphans();
    break;
  case "kill-broker":
    await cmdKillBroker();
    break;
  default:
    console.log(`usage:
  bun cli.ts status
  bun cli.ts peers
  bun cli.ts send <name-or-id> <message>
  bun cli.ts rename <name-or-id> <new-name>
  bun cli.ts messages
  bun cli.ts orphaned-messages
  bun cli.ts kill-broker`);
    process.exit(sub ? 2 : 0);
}
