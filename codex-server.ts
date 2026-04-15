#!/usr/bin/env bun
// codex-server.ts
// MCP stdio server for Codex CLI. Registers as peer_type="codex".
//
// DELIVERY PIPELINE (three layers, all feeding the same dedupe set):
//
//   1. Background poll (POLL_INTERVAL_MS) → durable on-disk inbox queue at
//      ~/.agent-peers-codex/<peer-id>.json. This is the authoritative
//      persistence layer: messages survive MCP process restarts and never
//      get lost on the path between "broker lease" and "model actually saw
//      them". File perms hardened to 0o600 (dir 0o700) to match the
//      broker's DB trust boundary (see broker.ts enforceDbFilePerms).
//
//   2. Best-effort MCP `notifications/message` push on each poll tick.
//      Recent Codex CLI versions surface MCP log notifications into the
//      live transcript, giving Codex a Claude-style mid-task delivery
//      channel. If the client doesn't plumb log notifications, the push is
//      a no-op — layer 3 still delivers the message reliably. This path
//      intentionally does NOT mark seen or ack; those stay gated on the
//      authoritative drain (layer 3).
//
//   3. Piggyback drain on every agent-peers tool call. withPiggyback
//      consumes unread messages from the durable queue, prepends them as
//      a [PEER INBOX] block, marks them seen, and queues ack-on-next-call.
//      This is the path that actually guarantees the model saw the bytes.
//
// Shared `seen` set across all three layers prevents the same message
// being injected twice — layer 2's push is a "preview," layer 3 is
// authoritative, layer 1 dedupes by message_id.
//
// Shutdown: clear timers and exit. Deliberately do NOT flush pendingAcks
// (those messages may not have reached Codex yet — flushing on exit would
// be silent loss). Deliberately do NOT unregister (preserves
// reclaim-by-name). Durable queue is left in place so a restart within the
// 60s reclaim window picks up exactly where this session left off.
//
// Dedupe scope: session-local in-memory seen-set keyed by message_id, plus
// durable dedupe-by-message_id in CodexInboxStore. At-least-once across
// restart per spec §5.4.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { waitForSharedSecret } from "./shared/shared-secret.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle, clearTabTitle, clearTabTitleSync } from "./shared/tab-title.ts";
import { formatInboxBlock } from "./shared/piggyback.ts";
import { CodexInboxStore } from "./shared/codex-inbox.ts";
import { isValidName } from "./shared/names.ts";
import { COLLEAGUE_PROTOCOL } from "./shared/colleague-prompt.ts";
import type { PeerId, LeasedMessage } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) {
  console.error(`[agent-peers/codex] ${msg}`);
}

let client: ReturnType<typeof createClient>;
async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

let myId: PeerId | null = null;
let myName: string | null = null;
let mySession: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let inboxStore: CodexInboxStore | null = null;
let pollInFlight: Promise<void> | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    // `logging: {}` enables MCP `notifications/message` — the background
    // poll loop uses this as a best-effort "preview" push so recent Codex
    // CLI versions see peer messages mid-task even when no agent-peers
    // tool call has fired yet. Authoritative delivery still runs through
    // the durable inbox queue + tool-response [PEER INBOX] block.
    capabilities: { logging: {}, tools: {} },
    instructions: `${COLLEAGUE_PROTOCOL}

DELIVERY ON THIS SIDE (Codex): this server keeps a local durable inbox
refreshed every second from the broker. Peer messages reach you via:

  1. A best-effort MCP \`notifications/message\` log push on each poll tick
     (recent Codex CLI versions surface this into the live transcript).
  2. A \`[PEER INBOX]\` block prepended to ANY agent-peers tool response —
     this is the authoritative delivery. When you see the block, apply
     the REACTIVE rules above.

Because path (1) is best-effort, whenever you're in a collaborative flow
or expecting a reply, call \`check_messages\` every 2-3 of your own turns —
it's free and it flushes the local inbox.`,
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

async function pollBrokerIntoQueue(): Promise<void> {
  if (!myId || !mySession || !inboxStore) return;
  if (pollInFlight) {
    await pollInFlight;
    return;
  }

  pollInFlight = (async () => {
    let leased: LeasedMessage[] = [];
    try {
      leased = await client.pollMessages({ id: myId!, session_token: mySession! });
    } catch (e) {
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (leased.length === 0) return;

    const unread: LeasedMessage[] = [];
    for (const message of leased) {
      if (seen.has(message.id)) {
        enqueueAck(message.lease_token);
      } else {
        unread.push(message);
      }
    }

    if (unread.length === 0) return;

    // Authoritative persistence FIRST — if this fails, we neither push nor
    // ack; next poll tick will retry because lease will expire at broker.
    try {
      await inboxStore.queueLeasedMessages(unread);
      log(`queued ${unread.length} unread peer message(s): ${unread.map((msg) => `#${msg.id} from ${msg.from_name}`).join(", ")}`);
    } catch (e) {
      log(`failed to persist unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Best-effort preview push via MCP log notifications. Fires AFTER the
    // durable write so a push-then-crash still leaves the messages
    // recoverable on next start. Failures are non-fatal — the authoritative
    // [PEER INBOX] block on the next tool call will still deliver.
    for (const m of unread) {
      try {
        await mcp.notification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "agent-peers",
            data: formatInboxBlock([m]),
            _meta: {
              source: "agent-peers",
              message_id: m.id,
              from_id: m.from_id,
              from_name: m.from_name,
              from_peer_type: m.from_peer_type,
              from_summary: m.from_summary,
              from_cwd: m.from_cwd,
              sent_at: m.sent_at,
            },
          },
        });
      } catch (e) {
        log(`preview push failed for msg #${m.id} (non-fatal; tool-call will deliver): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  })();

  try {
    await pollInFlight;
  } finally {
    pollInFlight = null;
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

  try {
    await pollBrokerIntoQueue();
  } catch (e) {
    log(`inline poll failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let fresh: LeasedMessage[] = [];
  try {
    fresh = inboxStore ? await inboxStore.consumeUnreadMessages() : [];
  } catch (e) {
    log(`failed to read unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const message of fresh) {
    seen.add(message.id);
    enqueueAck(message.lease_token);
  }

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

  // Arm full signal-level title-clear before any setTabTitle() call.
  // Rationale (verified by Codex adversarial review): an unhandled SIGHUP
  // exits with status 129 and does NOT fire the 'exit' event. So we install
  // SIGINT/SIGTERM/SIGHUP/SIGQUIT handlers immediately — not just 'exit' —
  // that sync-clear the title, optionally run whatever deferred cleanup is
  // wired, then exit. This closes the startup window where setTabTitle has
  // already fired but the full lifecycle cleanup isn't wired yet.
  let lifecycleCleanup: (() => Promise<void> | void) | null = null;
  const earlyKillHandler = async () => {
    try {
      if (lifecycleCleanup) await lifecycleCleanup();
    } catch { /* best effort during death */ }
    clearTabTitleSync();
    process.exit(0);
  };
  process.on("SIGINT", earlyKillHandler);
  process.on("SIGTERM", earlyKillHandler);
  process.on("SIGHUP", earlyKillHandler);
  process.on("SIGQUIT", earlyKillHandler);
  process.on("exit", clearTabTitleSync);

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(isBrokerAlive, brokerScriptUrl);
  const sharedSecret = await waitForSharedSecret();
  client = createClient(BROKER_URL, sharedSecret);

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
  inboxStore = new CodexInboxStore({ peerId: myId });
  await inboxStore.init();
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

  let pollStopped = false;
  let pollTickTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleNextPoll = () => {
    if (pollStopped) return;
    pollTickTimer = setTimeout(async () => {
      try { await pollBrokerIntoQueue(); }
      finally { scheduleNextPoll(); }
    }, POLL_INTERVAL_MS);
  };
  scheduleNextPoll();

  const hb = setInterval(async () => {
    if (myId && mySession) {
      try { await client.heartbeat({ id: myId, session_token: mySession }); } catch { /* non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Wire deferred lifecycle cleanup into the earlyKillHandler registered at
  // the top of main(). Intentionally NO pendingAcks flush (spec §5.5) and NO
  // unregister (preserves reclaim-by-name window). Timer cleanup only.
  lifecycleCleanup = async () => {
    clearInterval(hb);
    pollStopped = true;
    if (pollTickTimer) clearTimeout(pollTickTimer);
  };
  // Note: all signal handlers + 'exit' handler are already armed at the top
  // of main(), before any setTabTitle() call — so a terminal close during
  // startup also clears the title.
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
