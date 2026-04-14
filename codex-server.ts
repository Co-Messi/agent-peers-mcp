#!/usr/bin/env bun
// codex-server.ts
// MCP stdio server for Codex CLI. Registers as peer_type="codex". Uses piggyback
// delivery: every tool handler polls the broker at entry, prepends any pending
// peer messages as a [PEER INBOX] block in the response text, and defers the ack
// to the NEXT tool call (ack-on-next-call pattern, spec §5.5).
//
// Shutdown: clear timers and exit. Deliberately do NOT flush pendingAcks
// (those messages may not have reached Codex yet — flushing on exit would be
// silent loss). Deliberately do NOT unregister (preserves reclaim-by-name).
//
// Dedupe: in-memory seen-set keyed by message_id. Session-local only;
// at-least-once across restart per spec §5.4.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle, clearTabTitle, clearTabTitleSync } from "./shared/tab-title.ts";
import { formatInboxBlock } from "./shared/piggyback.ts";
import { isValidName } from "./shared/names.ts";
import type { PeerId, LeasedMessage } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) {
  console.error(`[agent-peers/codex] ${msg}`);
}

const client = createClient(BROKER_URL);

let myId: PeerId | null = null;
let myName: string | null = null;
let mySession: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: `You are connected to the agent-peers network — other AI agents on this machine (Claude Code or Codex) can discover you and send you messages.

INBOX HANDLING — IMPORTANT:
- This MCP does NOT push messages to you. You receive messages ONLY when you call a tool on this server; the response is prepended with a [PEER INBOX] block listing pending peer messages.
- When the user says things like "wait for a reply", "did I get a message", or is in a collaborative flow with other peers, you MUST call check_messages (or any agent-peers tool) regularly — otherwise peer messages pile up at the broker unseen.
- Default cadence: after completing every major step of a multi-peer task, call check_messages before moving on. When idle waiting for a reply, call check_messages every few user turns.
- When you see a [PEER INBOX] block, treat each message like a coworker's Slack message: finish your current step, then respond via send_message(to_id=<from_name>, message="..."). The from_name and message_id are inside the block.

ON STARTUP:
- Call set_summary once with a 1-2 sentence description of what you are working on.

PEER DISCOVERY:
- Use list_peers with scope="machine" to see all agents, "directory" for same cwd, "repo" for same git repo.
- Each peer has a human-readable "name" (e.g. "frontend-tab") and an immutable UUID "id". peer_type is "claude" or "codex".

TOOLS:
- list_peers(scope, peer_type?)       — also surfaces any pending inbox
- send_message(to_id, message)        — to_id accepts UUID or name; also surfaces inbox
- set_summary(summary)                — also surfaces inbox
- check_messages                      — explicit inbox poll, call this when waiting for replies
- rename_peer(new_name)               — YOURSELF only; 1-32 chars, [a-zA-Z0-9_-]`,
  },
);

const TOOLS = [
  {
    name: "list_peers",
    description: "List other AI agent peers on this machine.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string" as const, enum: ["machine", "directory", "repo"] },
        peer_type: { type: "string" as const, enum: ["claude", "codex"] },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to a peer (to_id accepts UUID or name).",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const },
        message: { type: "string" as const },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description: "Set a 1-2 sentence summary of current work.",
    inputSchema: {
      type: "object" as const,
      properties: { summary: { type: "string" as const } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Passive trigger to surface pending inbox (same effect as any other tool call; does no extra work).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "rename_peer",
    description: "Rename YOURSELF. 1-32 chars, [a-zA-Z0-9_-].",
    inputSchema: {
      type: "object" as const,
      properties: { new_name: { type: "string" as const } },
      required: ["new_name"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Module-level ack-on-next-call state (spec §5.5).
// pendingAcks holds lease tokens from the PREVIOUS tool call. A subsequent
// request is a strong heuristic (not proof) that the previous response cycle
// completed — see spec §5.5 "Residual limitations" for the narrow window this
// does not fully close. On shutdown we intentionally do NOT flush pendingAcks;
// let leases expire naturally.
//
// Bounded (code review round-2 fix): under repeated ack failure we'd otherwise
// accumulate unbounded tokens. Cap keeps memory + HTTP payload sane. Oldest
// tokens are dropped first; they'd have expired leases anyway (30s lease
// horizon vs cap large enough to cover many minutes of new leases), so the
// broker would have ack'd them 0 regardless.
const MAX_PENDING_ACKS = 500;
const pendingAcks: string[] = [];
const seen = new Set<number>();

function enqueueAck(token: string) {
  pendingAcks.push(token);
  if (pendingAcks.length > MAX_PENDING_ACKS) {
    const drop = pendingAcks.length - MAX_PENDING_ACKS;
    pendingAcks.splice(0, drop);
    log(`pendingAcks trimmed: dropped ${drop} oldest token(s); exceeding cap ${MAX_PENDING_ACKS}`);
  }
}

async function withPiggyback(
  handler: () => Promise<{ text: string; isError?: boolean }>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (!myId || !mySession) {
    return {
      content: [{ type: "text", text: "Not registered with broker yet" }],
      isError: true,
    };
  }

  // 1. Flush previous-call acks. Only now do we know the previous response
  //    cycle completed (Codex is calling us again).
  //
  // Code review round-1 fix: only remove tokens from pendingAcks on SUCCESSFUL
  // ack. If the HTTP call throws, keep them so the next call retries instead
  // of silently waiting for lease expiry (which would cause a guaranteed
  // duplicate when the message is re-leased + re-injected).
  if (pendingAcks.length > 0) {
    const toFlush = pendingAcks.slice();
    try {
      await client.ackMessages({ id: myId, session_token: mySession, lease_tokens: toFlush });
      // Remove only after success. Use splice by indices-of-toFlush to be
      // robust against concurrent appends (though withPiggyback is strictly
      // serialized per tool call, so this is defense in depth).
      for (const tok of toFlush) {
        const idx = pendingAcks.indexOf(tok);
        if (idx !== -1) pendingAcks.splice(idx, 1);
      }
    } catch (e) {
      log(`pending ack flush failed (will retry next call): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Poll for new messages.
  let leased: LeasedMessage[] = [];
  try {
    leased = await client.pollMessages({ id: myId, session_token: mySession });
  } catch (e) {
    log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Partition polled messages into fresh vs re-delivery.
  const fresh: LeasedMessage[] = [];
  for (const m of leased) {
    if (seen.has(m.id)) {
      // Re-delivery after lost ack. Queue lease token for next-call ack so the
      // broker can finally close the stuck lease. Do NOT re-inject.
      enqueueAck(m.lease_token);
    } else {
      fresh.push(m);
      seen.add(m.id);
      enqueueAck(m.lease_token);
    }
  }

  // 4. Run the tool's own logic.
  let toolText = "";
  let toolError: boolean | undefined;
  try {
    const r = await handler();
    toolText = r.text;
    toolError = r.isError;
  } catch (e) {
    toolText = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
    toolError = true;
  }

  // 5. Return response with inbox prepended. Ack happens on the NEXT call.
  const inbox = formatInboxBlock(fresh);
  const finalText = inbox + toolText;
  return { content: [{ type: "text", text: finalText }], isError: toolError };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  return withPiggyback(async () => {
    switch (name) {
      case "list_peers": {
        const { scope, peer_type } = args as {
          scope: "machine" | "directory" | "repo";
          peer_type?: "claude" | "codex";
        };
        const peers = await client.listPeers({
          scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId!, peer_type,
        });
        if (peers.length === 0) {
          return { text: `No other peers found (scope: ${scope}).` };
        }
        const lines = peers.map((p) =>
          [
            `Peer ${p.name} (${p.peer_type})`,
            `  ID: ${p.id}`,
            `  CWD: ${p.cwd}`,
            p.tty ? `  TTY: ${p.tty}` : null,
            p.summary ? `  Summary: ${p.summary}` : null,
            `  Last seen: ${p.last_seen}`,
          ].filter(Boolean).join("\n")
        );
        return { text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` };
      }

      case "send_message": {
        const { to_id, message } = args as { to_id: string; message: string };
        const res = await client.sendMessage({
          from_id: myId!, session_token: mySession!, to_id_or_name: to_id, text: message,
        });
        if (!res.ok) return { text: `Send failed: ${res.error}`, isError: true };
        return { text: `Message sent (id=${res.message_id}).` };
      }

      case "set_summary": {
        const { summary } = args as { summary: string };
        await client.setSummary({ id: myId!, session_token: mySession!, summary });
        return { text: `Summary set: "${summary}"` };
      }

      case "check_messages": {
        // Piggyback already polled + injected; nothing extra to do.
        return { text: `Checked inbox.` };
      }

      case "rename_peer": {
        const { new_name } = args as { new_name: string };
        if (!isValidName(new_name)) {
          return { text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.`, isError: true };
        }
        const res = await client.renamePeer({ id: myId!, session_token: mySession!, new_name });
        if (!res.ok) return { text: `Rename failed: ${res.error}`, isError: true };
        myName = res.name ?? new_name;
        setTabTitle(`peer:${myName}`);
        return { text: `Renamed to ${myName}` };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  });
});

async function main() {
  // Activation gate — matches claude-server. If AGENT_PEERS_ENABLED is not "1",
  // run as a no-op MCP (no broker connection, no tab title). Codex sessions
  // set this via the `env = { "AGENT_PEERS_ENABLED" = "1" }` block in
  // ~/.codex/config.toml.
  if (process.env.AGENT_PEERS_ENABLED !== "1") {
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await mcp.connect(new StdioServerTransport());
    log("agent-peers disabled (set AGENT_PEERS_ENABLED=1 to activate); idle");
    return;
  }

  // Arm the sync title-clear before anything can call setTabTitle. See
  // claude-server main() for the rationale.
  process.on("exit", clearTabTitleSync);

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(client, brokerScriptUrl);

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const [branch, recent_files] = await Promise.all([
        getGitBranch(myCwd),
        getRecentFiles(myCwd),
      ]);
      initialSummary = await generateSummary({
        cwd: myCwd, git_root: myGitRoot, git_branch: branch, recent_files,
      });
    } catch {
      /* non-critical */
    }
  })();
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  const reg = await client.register({
    peer_type: "codex",
    name: process.env.PEER_NAME,
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  myName = reg.name;
  mySession = reg.session_token;
  setTabTitle(`peer:${myName}`);
  log(`Registered as ${myName} (id=${myId})`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId && mySession) {
        try { await client.setSummary({ id: myId, session_token: mySession, summary: initialSummary }); } catch { /* non-critical */ }
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const hb = setInterval(async () => {
    if (myId && mySession) {
      try { await client.heartbeat({ id: myId, session_token: mySession }); } catch { /* non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(hb);
    clearTabTitle(); // reset terminal title so `peer:<name>` doesn't persist after exit
    // Deliberately do NOT flush pendingAcks (spec §5.5).
    // Deliberately do NOT unregister (preserves reclaim-by-name window).
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
  process.on("SIGQUIT", cleanup);
  // process.on("exit", clearTabTitleSync) is already wired at the top of
  // main() so it protects pre-connect startup failures too.
}

main().catch(async (e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  // Clear any title set before the failure so the shell that inherits the tab
  // doesn't briefly see `peer:<name>` before the 'exit' handler fires.
  clearTabTitleSync();
  // Same rationale as claude-server: pre-connect failure has no active session
  // to preserve, so unregister the row so it doesn't block reclaim.
  if (myId && mySession) {
    try { await client.unregister({ id: myId, session_token: mySession }); } catch { /* best effort */ }
  }
  process.exit(1);
});
