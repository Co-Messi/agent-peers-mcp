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
  try {
    const res = await client.sendMessage({
      from_id: reg.id, to_id_or_name: targetNameOrId, text: message,
    });
    if (!res.ok) {
      console.error(`send failed: ${res.error}`);
      process.exit(1);
    }
    console.log(`sent (id=${res.message_id}, from=${reg.name})`);
  } finally {
    try { await client.unregister(reg.id); } catch { /* best effort */ }
  }
}

async function cmdRename(target: string, newName: string) {
  const peers = await client.listPeers({
    scope: "machine", cwd: process.cwd(), git_root: null,
  });
  const found = peers.find((p) => p.id === target || p.name === target);
  if (!found) {
    console.error(`no peer matching '${target}'`);
    process.exit(1);
  }
  const res = await client.renamePeer({ id: found.id, new_name: newName });
  if (!res.ok) {
    console.error(`rename failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`renamed ${found.name} -> ${res.name}`);
}

async function cmdOrphans() {
  // Hit the broker's /orphaned-messages endpoint (broker reads DB directly).
  const res = await fetch(`${BROKER_URL}/orphaned-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    console.error(`request failed: ${res.status}`);
    process.exit(1);
  }
  const { messages } = (await res.json()) as {
    messages: Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string }>;
  };
  if (messages.length === 0) {
    console.log("(no orphaned messages)");
    return;
  }
  for (const m of messages) {
    const preview = m.text.length > 80 ? m.text.slice(0, 77) + "..." : m.text;
    console.log(`#${m.id}  from=${m.from_id}  to=${m.to_id}  sent=${m.sent_at}`);
    console.log(`  ${preview}`);
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
  bun cli.ts orphaned-messages
  bun cli.ts kill-broker`);
    process.exit(sub ? 2 : 0);
}
