#!/usr/bin/env bun
// claude-server.ts
// MCP stdio server for Claude Code. Registers as peer_type="claude", declares
// claude/channel, pushes inbound messages instantly via channel notifications.
//
// Delivery pipeline: every 1s the polling loop leases messages, persists them
// in a stable-ID durable inbox, and emits a best-effort live channel push only
// for entries newly added to that inbox. Messages stay durable and eligible for
// re-presentation until the model explicitly calls ack_messages with their IDs.
//
// Shutdown: on SIGINT/SIGTERM we clear timers and exit without unregistering.
// Leaving the peer row lets a restart with the same PEER_NAME reclaim the UUID
// via broker /register, so undelivered messages keep routing (see spec §5.1).
//
// Dedupe scope: within-session only. Across restart (including reclaim-by-name),
// delivery is at-least-once — see spec §5.4.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient, isSessionExpiredError } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { readSharedSecret, waitForSharedSecret } from "./shared/shared-secret.ts";
import { canonicalizePath, getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle, clearTabTitle, clearTabTitleSync, startTabTitleKeepalive } from "./shared/tab-title.ts";
import { formatInboxBlock } from "./shared/piggyback.ts";
import { CodexInboxStore as DurableInboxStore } from "./shared/codex-inbox.ts";
import { isValidName } from "./shared/names.ts";
import { COLLEAGUE_PROTOCOL } from "./shared/colleague-prompt.ts";
import type { PeerId } from "./shared/types.ts";
import { sanitizeTerminalText as safe } from "./shared/safe-output.ts";
import { MAX_ACK_TOKENS, MAX_PRESENTATION_BYTES, MAX_PRESENTED_MESSAGES } from "./shared/limits.ts";
import { selectMessagesForPresentation } from "./shared/delivery-state.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./shared/logger.ts";
import { parsePort } from "./shared/config.ts";
import { loadPeerIdentity, savePeerIdentity } from "./shared/peer-identity.ts";
import { AsyncMutex } from "./shared/async-mutex.ts";
import { acknowledgeDurableMessages, parseExplicitAckIds } from "./shared/explicit-ack.ts";
import {
  parseListPeersToolArgs,
  parseRenameToolArgs,
  parseSendMessageToolArgs,
  parseSetSummaryToolArgs,
} from "./shared/validation.ts";

const BROKER_PORT = parsePort(process.env.AGENT_PEERS_PORT, 7900);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const logger = createLogger("claude-mcp");
const renameMutex = new AsyncMutex();

function log(msg: string) {
  logger.info("status", { detail: msg });
}

function exitIfSessionExpired(error: unknown): void {
  if (isSessionExpiredError(error)) {
    logger.error("session_expired");
    process.exit(1);
  }
}

// The shared secret is only known after the broker has provisioned it, so
// we defer client construction until main() can read the secret file.
let client: ReturnType<typeof createClient>;
async function isBrokerAlive(): Promise<boolean> {
  const secret = readSharedSecret();
  return secret ? createClient(BROKER_URL, secret).isAlive() : false;
}

let myId: PeerId | null = null;
let myName: string | null = null;
let mySession: string | null = null;
let myReclaimToken: string | null = null;
let stableIdentityKey: string | undefined;
let ownsStableIdentity = false;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let claudeInboxStore: DurableInboxStore | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `${COLLEAGUE_PROTOCOL}

DELIVERY ON THIS SIDE (Claude Code):

There are TWO surfaces for peer messages on your side, and you need
to use both:

  1. LIVE channel push (\`<channel source="agent-peers" ...>\`):
     Messages arrive instantly this way when a peer sends something
     WHILE you are actively in a turn. Treat these the moment you see
     them — apply the REACTIVE rules above (investigate first, reply
     only when substantive, push back on disagreement).

  2. BACKFILL via \`check_messages\`:
     When a peer sends a message while this session is IDLE at the
     prompt, Claude Code queues the channel push — the model doesn't
     see it until the next turn begins, and it may not render
     visibly even then. Calling \`check_messages\` returns a
     [PEER INBOX] block containing every unconfirmed peer message in
     the durable local inbox, so nothing gets lost to idle-queue silence.

RULE: Call \`check_messages\` as the FIRST thing you do at the START of
every user turn. This is the same rule Codex uses. It's one cheap
tool call. It surfaces anything that arrived while you were idle.
Without this habit, a peer DM sent while you were at the prompt
waits invisibly until something else happens to trigger a redraw.

Exception: you do NOT need to call \`check_messages\` again within the
same turn — once per turn is enough. If the user sent you a task
right after a peer message arrived mid-task, you've already seen it
via the live channel push, and check_messages will just re-show the
same thing.

After actually processing displayed messages, call
\`ack_messages(message_ids=[...])\` with their exact IDs. This explicit
call is the only durable delivery confirmation; until then, messages
remain eligible for re-presentation.`,
  },
);

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other AI agent peers on this machine. Returns id, human name, peer_type (claude|codex), cwd, summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string" as const, enum: ["machine", "directory", "repo"] },
        peer_type: { type: "string" as const, enum: ["claude", "codex"], description: "optional filter" },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a peer. to_id accepts either the peer's UUID or their human name (e.g. 'frontend-tab').",
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
    description: "Set a 1-2 sentence summary of your current work (visible to peers).",
    inputSchema: {
      type: "object" as const,
      properties: { summary: { type: "string" as const } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Surface unconfirmed messages from the durable local inbox. Call this at the START of every user turn; the live channel is best effort and may queue or drop idle deliveries.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "ack_messages",
    description: "Explicitly acknowledge peer messages only after processing them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_ids: { type: "array" as const, items: { type: "integer" as const, minimum: 1 }, minItems: 1, maxItems: MAX_ACK_TOKENS },
      },
      required: ["message_ids"],
    },
  },
  {
    name: "rename_peer",
    description:
      "Rename YOURSELF. new_name must be 1-32 chars, matching [a-zA-Z0-9_-]. Names must be unique among active peers.",
    inputSchema: {
      type: "object" as const,
      properties: { new_name: { type: "string" as const } },
      required: ["new_name"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!myId || !mySession) {
    return {
      content: [{ type: "text" as const, text: "Not registered with broker yet" }],
      isError: true,
    };
  }

  switch (name) {
    case "list_peers": {
      const { scope, peer_type } = parseListPeersToolArgs(args);
      const peers = await client.listPeers({
        scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId, peer_type,
      });
      if (peers.length === 0) {
        return { content: [{ type: "text" as const, text: `No other peers found (scope: ${scope}).` }] };
      }
      const lines = peers.map((p) =>
        [
          `Peer ${safe(p.name, 32)} (${p.peer_type})`,
          `  ID: ${safe(p.id, 128)}`,
          `  CWD: ${safe(p.cwd)}`,
          p.tty ? `  TTY: ${safe(p.tty, 256)}` : null,
          p.summary ? `  Summary: ${safe(p.summary, 1024)}` : null,
          `  Last seen: ${p.last_seen}`,
        ].filter(Boolean).join("\n")
      );
      return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` }] };
    }

    case "send_message": {
      const { to_id, message } = parseSendMessageToolArgs(args);
      const res = await client.sendMessage({
        from_id: myId, session_token: mySession, to_id_or_name: to_id, text: message,
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Send failed: ${res.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Message sent (id=${res.message_id}).` }] };
    }

    case "set_summary": {
      const { summary } = parseSetSummaryToolArgs(args);
      await client.setSummary({ id: myId, session_token: mySession, summary });
      return { content: [{ type: "text" as const, text: `Summary set: "${summary}"` }] };
    }

    case "check_messages": {
      // Return messages persisted before broker acknowledgement. Entries
      // remain durable until ack_messages provides explicit model evidence.
      const queued = claudeInboxStore ? await claudeInboxStore.getUnreadMessages() : [];
      const recent = selectMessagesForPresentation(queued, {
        maxMessages: MAX_PRESENTED_MESSAGES,
        maxBytes: MAX_PRESENTATION_BYTES,
      });
      if (recent.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No unconfirmed peer messages in the durable inbox. (Messages also arrive live mid-turn via the agent-peers channel when a peer sends something while you're active — this tool is the fallback for messages that arrived while this session was idle at the prompt.)",
          }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: formatInboxBlock(recent),
        }],
      };
    }

    case "ack_messages": {
      if (!claudeInboxStore) throw new Error("durable inbox is unavailable");
      const messageIds = parseExplicitAckIds(args);
      const result = await acknowledgeDurableMessages({
        store: claudeInboxStore,
        messageIds,
        maxBatchSize: MAX_ACK_TOKENS,
        ackBroker: async (leaseTokens) => {
          const response = await client.ackMessages({ id: myId!, session_token: mySession!, lease_tokens: leaseTokens });
          return response.acked_tokens;
        },
      });
      const missing = result.missing_ids.length > 0
        ? ` IDs not present in the durable inbox: ${result.missing_ids.join(", ")}.`
        : "";
      const warning = result.broker_error
        ? " Broker acknowledgement failed; safe duplicate delivery may occur."
        : result.broker_acked < result.acknowledged_ids.length
          ? " Some broker leases had expired; safe duplicate delivery may occur."
          : "";
      return { content: [{ type: "text" as const, text: `Acknowledged message IDs: ${result.acknowledged_ids.join(", ") || "none"}.${missing}${warning}` }] };
    }

    case "rename_peer": {
      return renameMutex.runExclusive(async () => {
        const { new_name } = parseRenameToolArgs(args);
        if (!isValidName(new_name)) {
          return {
            content: [{ type: "text" as const, text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.` }],
            isError: true,
          };
        }
        const res = await client.renamePeer({ id: myId!, session_token: mySession!, new_name });
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Rename failed: ${res.error}` }], isError: true };
        }
        const oldName = myName;
        const renamedName = res.name ?? new_name;
        if (stableIdentityKey && myReclaimToken && ownsStableIdentity) {
          try {
            const saved = await savePeerIdentity("claude", stableIdentityKey, {
              name: renamedName,
              reclaim_token: myReclaimToken,
            }, undefined, myReclaimToken, oldName ?? undefined);
            if (!saved) throw new Error("stable identity changed concurrently");
          } catch {
            const rollback = oldName
              ? await client.renamePeer({ id: myId!, session_token: mySession!, new_name: oldName })
              : { ok: false };
            if (rollback.ok) {
              return { content: [{ type: "text" as const, text: "Rename could not be persisted and was rolled back." }], isError: true };
            }
            myName = renamedName;
            return { content: [{ type: "text" as const, text: "Renamed, but durable identity persistence failed; restart recovery is not safe." }], isError: true };
          }
        }
        myName = renamedName;
        setTabTitle(`peer:${myName}`);
        return { content: [{ type: "text" as const, text: `Renamed to ${myName}` }] };
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  // Activation gate — the MCP is globally registered in ~/.claude.json so every
  // `claude` session spawns this process. If AGENT_PEERS_ENABLED is not "1",
  // we run as a no-op MCP: connect, expose zero tools, don't touch the broker,
  // don't set the terminal title. The `agentpeers` alias sets the env var;
  // plain `claude` doesn't. This prevents the peer network from activating
  // (and renaming your tab) in every unrelated Claude session.
  if (process.env.AGENT_PEERS_ENABLED !== "1") {
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await mcp.connect(new StdioServerTransport());
    log("agent-peers disabled (set AGENT_PEERS_ENABLED=1 to activate); idle");
    return;
  }

  // Arm the terminal-title cleanup BEFORE any code path that could call
  // setTabTitle. The `exit` handler covers the explicit process.exit() path,
  // but an UNHANDLED SIGHUP (e.g. the user closes the tab during startup,
  // after setTabTitle has fired) terminates with status 129 and does NOT
  // trigger `exit`. So we ALSO install signal handlers immediately, even
  // before the rest of the lifecycle wiring exists. They call a
  // lifecycle-aware cleanup that runs whatever deferred work (timers,
  // pending acks) is ready, then sync-clears the title and exits.
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

  // Write a placeholder title + arm the keepalive BEFORE register() so
  // there's no "node" window between MCP-spawn and peer-registered.
  // The post-register setTabTitle(`peer:${myName}`) overwrites this
  // placeholder with the real name. Fixes the bug where fresh sessions
  // showed "node" for 3-5s (the time register + generateSummary takes).
  setTabTitle("peer:starting");
  startTabTitleKeepalive();

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(isBrokerAlive, brokerScriptUrl);
  // Now that the broker is up, read the per-user shared secret it wrote into
  // ~/.agent-peers-secret (file mode 0600) and construct an authenticated
  // HTTP client with it.
  const sharedSecret = await waitForSharedSecret();
  client = createClient(BROKER_URL, sharedSecret);

  myCwd = await canonicalizePath(process.cwd());
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // Best-effort auto-summary with 3s cap; register may proceed with empty summary.
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

  const requestedName = process.env.PEER_NAME;
  stableIdentityKey = requestedName;
  const storedIdentity = await loadPeerIdentity("claude", requestedName);
  const reg = await client.register({
    peer_type: "claude",
    name: storedIdentity?.name ?? requestedName,
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    reclaim_token: storedIdentity?.reclaim_token,
  });
  ownsStableIdentity = await savePeerIdentity(
    "claude",
    requestedName,
    { name: reg.name, reclaim_token: reg.reclaim_token },
    undefined,
    storedIdentity?.reclaim_token ?? null,
    storedIdentity?.name,
  );
  myId = reg.id;
  myName = reg.name;
  mySession = reg.session_token;
  myReclaimToken = reg.reclaim_token;
  claudeInboxStore = new DurableInboxStore({
    peerId: myId,
    rootDir: process.env.AGENT_PEERS_CLAUDE_STATE_DIR ?? join(homedir(), ".agent-peers-claude"),
  });
  await claudeInboxStore.init();
  setTabTitle(`peer:${myName}`);
  // Note: keepalive was already armed earlier in main(), before register().
  // The setTabTitle above just updates `lastTitle`; the running keepalive
  // will re-assert the new name on its next tick (≤1s).
  log(`Registered as ${myName} (id=${myId})`);

  // Late summary upload if generation took longer than 3s.
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId && mySession) {
        try {
          await client.setSummary({ id: myId, session_token: mySession, summary: initialSummary });
        } catch {
          /* non-critical */
        }
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollAndPush = async () => {
    if (!myId || !mySession || !claudeInboxStore) return;
    try {
      const msgs = await client.pollMessages({ id: myId, session_token: mySession });
      if (msgs.length === 0) return;

      const alreadyQueued = new Set((await claudeInboxStore.getUnreadMessages()).map((message) => message.id));
      // Persist before presentation. Broker acknowledgement is deferred until
      // the model explicitly calls ack_messages.
      await claudeInboxStore.queueLeasedMessages(msgs);

      for (const m of msgs) {
        if (alreadyQueued.has(m.id)) continue;
        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: formatInboxBlock([m]),
              meta: {
                message_id: String(m.id),
                from_id: m.from_id,
                from_name: m.from_name,
                from_peer_type: m.from_peer_type,
                sent_at: m.sent_at,
              },
            },
          });
          log(`pushed channel message id=${m.id} from=${m.from_name} type=${m.from_peer_type}`);
        } catch (e) {
          // The durable inbox remains authoritative even if the live hint is
          // unavailable; check_messages will surface the message.
          log(`channel push failed; durable inbox retained id=${m.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

    } catch (e) {
      exitIfSessionExpired(e);
      log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Self-scheduling loop with re-entrancy guard (current lifecycle invariant).
  // Using setInterval would fire a new poll every 1s even if the previous one is
  // still in flight, causing overlapping reads of the same `seen` set and
  // duplicate pushes under slow I/O. This pattern guarantees strictly one
  // in-flight cycle at a time.
  let pushStopped = false;
  let pushTickTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleNextPush = () => {
    if (pushStopped) return;
    pushTickTimer = setTimeout(async () => {
      try { await pollAndPush(); }
      finally { scheduleNextPush(); }
    }, POLL_INTERVAL_MS);
  };
  scheduleNextPush();

  const hb = setInterval(async () => {
    if (myId && mySession) {
      try { await client.heartbeat({ id: myId, session_token: mySession }); }
      catch (e) { exitIfSessionExpired(e); }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Wire the deferred lifecycle cleanup into the earlyKillHandler registered
  // at the top of main(). When any fatal signal arrives now, earlyKillHandler
  // will call this to clean up timers + deliberately NOT unregister (to preserve
  // reclaim-by-name), then sync-clear the title, then exit.
  lifecycleCleanup = async () => {
    clearInterval(hb);
    pushStopped = true;
    if (pushTickTimer) clearTimeout(pushTickTimer);
  };
  // Note: SIGINT / SIGTERM / SIGHUP / SIGQUIT / exit handlers are already
  // registered earlier in main(), before any setTabTitle() call, so terminal
  // close during startup also clears the title.
}

main().catch(async (e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  // Clear any title we may have set before the failure — don't wait for the
  // 'exit' handler (which will also run) to avoid a visible flicker where the
  // user's shell briefly inherits `peer:<name>` before reset.
  clearTabTitleSync();
  // If we registered with the broker but failed BEFORE mcp.connect() or before
  // signal handlers were installed, no active session exists to preserve for
  // reclaim. Unregister explicitly so the row doesn't block same-name reclaim
  // for 60s. Post-connect failures use the signal-handler path (no unregister).
  if (myId && mySession) {
    try { await client.unregister({ id: myId, session_token: mySession }); } catch { /* best effort */ }
  }
  process.exit(1);
});
