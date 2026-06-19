#!/usr/bin/env bun
// codex-server.ts
// MCP stdio server for Codex CLI. Registers as peer_type="codex".
//
// DELIVERY PIPELINE — two layers with a strict division of labor, driven
// by one invariant: no message is acked to the broker (nor pruned from
// the durable queue) until we have evidence the previous tool-response
// cycle actually completed. That evidence is "Codex called us again."
//
//   Layer 1 — Durable on-disk inbox at ~/.agent-peers-codex/<peer-id>.json
//   ------------------------------------------------------------------
//   Background poll (POLL_INTERVAL_MS) writes newly-leased messages here.
//   This is the authoritative persistence layer: messages survive MCP
//   restart within the 60s reclaim window, and nothing gets pruned until
//   we're sure the model actually saw it. File perms hardened to 0o600
//   (dir 0o700) to match the broker's DB trust boundary (see
//   broker.ts enforceDbFilePerms).
//
//   Layer 2 — Authoritative piggyback [PEER INBOX] on tool call
//   ------------------------------------------------------------------
//   withPiggyback is the ONLY path that surfaces message CONTENT + reply
//   cues to the model. It reads (not consumes) from the durable queue,
//   prepends unacknowledged messages as a [PEER INBOX] block in the tool
//   response. Only an explicit ack_messages call removes durable entries.
//
//   Signal-only preview push (notifications/message)
//   ------------------------------------------------------------------
//   A best-effort MCP log notification fires after each background poll
//   that landed new messages in the queue. It carries ONLY the sender's
//   name + peer_type and a pointer to the next tool call — no body, no
//   reply_action. This gives recent Codex CLI versions a "new message
//   from X arrived, look at your inbox" signal in the live transcript
//   without duplicating the authoritative delivery. It does NOT update
//   any delivery state — only an explicit ack_messages call confirms IDs.
//
// DELIVERY CONFIRMATION:
//
//   Returning a tool response, or merely receiving the next tool call, is not
//   proof that the model processed the inbox. Messages therefore stay in the
//   durable queue and are re-presented until the model explicitly invokes
//   ack_messages with their IDs. This gives at-least-once delivery across
//   dropped responses, process restarts, and expired broker leases.
//
// Shutdown: clear timers and exit. Deliberately do NOT acknowledge durable
// inbox entries and do NOT unregister (preserves
// reclaim-by-name). Durable queue stays on disk so a restart within the
// 60s reclaim window picks up exactly where this session left off.

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
import { formatInboxBlock, formatInboxPreview } from "./shared/piggyback.ts";
import { CodexInboxStore } from "./shared/codex-inbox.ts";
import { isValidName } from "./shared/names.ts";
import { COLLEAGUE_PROTOCOL } from "./shared/colleague-prompt.ts";
import { waitForFreshPeerMessages as waitForFreshPeerMessagesLoop } from "./shared/wait-for-peer-messages.ts";
import { WakeRegistry, hashBrokerSessionToken } from "./shared/wake-registry.ts";
import { WakeLaunchClaimStore, type CompleteWakeLaunchClaim } from "./shared/wake-launch-claims.ts";
import type { PeerId, LeasedMessage } from "./shared/types.ts";
import { sanitizeTerminalText as safe } from "./shared/safe-output.ts";
import { selectMessagesForPresentation } from "./shared/delivery-state.ts";
import { MAX_ACK_TOKENS, MAX_PRESENTATION_BYTES, MAX_PRESENTED_MESSAGES } from "./shared/limits.ts";
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
const logger = createLogger("codex-mcp");
const renameMutex = new AsyncMutex();
const WAIT_FOR_MESSAGES_DEFAULT_MS = 300_000;
const WAIT_FOR_MESSAGES_MAX_MS = 300_000;
const WAIT_FOR_MESSAGES_POLL_MS = 500;

function log(msg: string) {
  logger.info("status", { detail: msg });
}

function exitIfSessionExpired(error: unknown): void {
  if (isSessionExpiredError(error)) {
    logger.error("session_expired");
    process.exit(1);
  }
}

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
let inboxStore: CodexInboxStore | null = null;
let pollInFlight: Promise<void> | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    // `logging: {}` enables MCP `notifications/message`. Current (v0.120)
    // Codex CLI does NOT surface these to the model — confirmed via the
    // official docs at github.com/openai/codex/docs/config.md which list
    // only `tools` as a supported MCP feature. We keep the capability +
    // keep sending the preview pushes as future-compatible plumbing, but
    // the authoritative delivery channel is the [PEER INBOX] block in
    // tool responses (Codex's only MCP input surface). The prompt above
    // instructs Codex to call `check_messages` at the start of every
    // user turn to keep delivery latency bounded by one user turn
    // instead of "until Codex happens to call an agent-peers tool."
    capabilities: { logging: {}, tools: {} },
    instructions: `${COLLEAGUE_PROTOCOL}

DELIVERY ON THIS SIDE (Codex) — READ CAREFULLY, THIS IS LOAD-BEARING:

The current Codex CLI does NOT surface mid-task MCP push notifications
to the model. That means you do not see peer messages the instant they
arrive — you only see them when YOU call an agent-peers tool. A peer
can send you a DM at 10:00; if you don't touch agent-peers until 10:20,
you won't know about it until 10:20. This is a hard constraint of the
Codex runtime, not a bug in this server.

RULE: Call \`check_messages\` as the FIRST thing you do every time the
user sends you a message. It is one cheap tool call. It surfaces any
pending peer inbox as a \`[PEER INBOX]\` block prepended to the
response. Without this habit, peer messages pile up for minutes or
hours before you notice them — and the "colleague" experience
collapses into "broken chat."

Exceptions: you do NOT need to call \`check_messages\` before:
  - calling another agent-peers tool in the same turn (they all surface
    the inbox too — \`list_peers\`, \`send_message\`, \`set_summary\`,
    and \`rename_peer\` all prepend \`[PEER INBOX]\` if there is one)
  - running a long sequence of file-editing / shell tools where you
    have no reason to expect a peer interaction. Even then, call
    \`check_messages\` again at the start of the next user turn.

If the user asks you to stand by for peer collaboration, call
\`wait_for_peer_messages\` with a bounded timeout. It keeps this same
Codex turn alive until messages arrive or the timeout expires; it is not
the same as waking a fully idle session.

DELIVERY CHANNELS:

  1. \`[PEER INBOX]\` block prepended to ANY agent-peers tool response.
     This is the AUTHORITATIVE delivery — full message body, sender
     identity, reply instructions. When you see it, apply the REACTIVE
     rules above.

  2. A best-effort MCP \`notifications/message\` log push also fires
     on each background poll tick, but current Codex CLI does not
     expose these to the model. Treat the [PEER INBOX] block as your
     only input. Path (2) is future-compatible plumbing.

After actually processing displayed messages, call
\`ack_messages(message_ids=[...])\` with their exact IDs. This explicit
call is the only durable delivery confirmation; until then, messages
remain eligible for re-presentation.`,
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
      "Surface peer messages waiting in the inbox. Call this at the START of every user turn — Codex only sees peer messages on the response of an agent-peers tool call, so without this habit, messages sent while you were idle (or working on non-peer tools) wait invisibly. One cheap call.",
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
    name: "wait_for_peer_messages",
    description:
      "Stand by for incoming peer messages for up to timeout_ms, then surface them through the normal [PEER INBOX] tool-response path. This keeps this same Codex turn alive; it is not a fully idle wake mechanism.",
    inputSchema: {
      type: "object" as const,
      properties: {
        timeout_ms: {
          type: "number" as const,
          minimum: 0,
          maximum: WAIT_FOR_MESSAGES_MAX_MS,
          description: "Maximum time to wait, in milliseconds (default and max: 300000).",
        },
      },
    },
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

async function waitForFreshPeerMessages(timeoutMs: number): Promise<boolean> {
  return waitForFreshPeerMessagesLoop({
    timeoutMs,
    pollIntervalMs: WAIT_FOR_MESSAGES_POLL_MS,
    poll: pollBrokerIntoQueue,
    readUnread: async () => inboxStore ? inboxStore.getUnreadMessages() : [],
    // Every durable entry remains pending until explicit acknowledgement.
    isFresh: () => true,
    onError: (message) => log(`wait_for_peer_messages ${message}`),
  });
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
      exitIfSessionExpired(e);
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (leased.length === 0) return;

    const existingIds = new Set((await inboxStore.getUnreadMessages()).map((message) => message.id));
    const freshlyUnread = leased.filter((message) => !existingIds.has(message.id));

    // Authoritative persistence FIRST — if this fails, we do not push and
    // do not ack; next poll tick retries because the lease will expire at
    // the broker and the message will be re-leased.
    try {
      await inboxStore.queueLeasedMessages(leased);
      log(`queued ${freshlyUnread.length} unread peer message(s): ${freshlyUnread.map((msg) => `#${msg.id} from ${msg.from_name}`).join(", ")}`);
    } catch (e) {
      log(`failed to persist unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Best-effort signal-only preview push. Current Codex clients do not
    // surface MCP log notifications to the model, so this is dormant,
    // future-compatible plumbing. It carries NO
    // body and NO reply cues; full content + reply_action live in the
    // authoritative [PEER INBOX] block in the next tool response. This
    // split avoids the double-reply risk where the model would see the
    // same message twice (once via log, once via piggyback) and send two
    // replies. Failures are non-fatal — the authoritative path still
    // delivers on the next tool call.
    for (const m of freshlyUnread) {
      try {
        await mcp.notification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "agent-peers",
            // Intentionally body-free: just the sender's identity + a
            // pointer to where the actual message will appear. No
            // message text. No reply_action. See formatInboxPreview for
            // the rationale and the tests in piggyback.test.ts that
            // guarantee this property.
            data: formatInboxPreview(m),
            _meta: {
              source: "agent-peers",
              signal_only: true,
              message_id: m.id,
              from_id: m.from_id,
              from_name: m.from_name,
              from_peer_type: m.from_peer_type,
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
  opts: { suppressInbox?: boolean; beforeReadQueue?: () => Promise<void> } = {},
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (!myId || !mySession) {
    return { content: [{ type: "text", text: "Not registered with broker yet" }], isError: true };
  }

  // Pull immediately so the response includes mail that arrived just before
  // this tool call. Durable entries remain eligible on every response until
  // the model explicitly acknowledges their message IDs.
  try {
    await pollBrokerIntoQueue();
  } catch (error) {
    log(`inline poll failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Optional pre-draw hook for tools that need to wait before the inbox
  // snapshot is taken. In particular, wait_for_peer_messages must block here
  // rather than inside its handler, otherwise messages arriving during the
  // wait would miss this response's [PEER INBOX] block.
  try {
    await opts.beforeReadQueue?.();
  } catch (e) {
    log(`before-read hook failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let queued: LeasedMessage[] = [];
  try {
    queued = inboxStore ? await inboxStore.getUnreadMessages() : [];
  } catch (error) {
    log(`failed to read unread peer messages: ${error instanceof Error ? error.message : String(error)}`);
  }
  const displayed = opts.suppressInbox ? [] : selectMessagesForPresentation(queued, {
    maxMessages: MAX_PRESENTED_MESSAGES,
    maxBytes: MAX_PRESENTATION_BYTES,
  });

  let toolText = "";
  let toolError: boolean | undefined;
  try {
    const result = await handler();
    toolText = result.text;
    toolError = result.isError;
  } catch (error) {
    toolText = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
    toolError = true;
  }

  return {
    content: [{ type: "text", text: formatInboxBlock(displayed) + toolText }],
    isError: toolError,
  };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let waitResult: { didWait: boolean; found: boolean; timeoutMs: number } | null = null;

  return withPiggyback(async () => {
    switch (name) {
      case "list_peers": {
        const { scope, peer_type } = parseListPeersToolArgs(args);
        const peers = await client.listPeers({
          scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId!, peer_type,
        });
        if (peers.length === 0) {
          return { text: `No other peers found (scope: ${scope}).` };
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
        return { text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` };
      }

      case "send_message": {
        const { to_id, message } = parseSendMessageToolArgs(args);
        const res = await client.sendMessage({
          from_id: myId!, session_token: mySession!, to_id_or_name: to_id, text: message,
        });
        if (!res.ok) return { text: `Send failed: ${res.error}`, isError: true };
        return { text: `Message sent (id=${res.message_id}).` };
      }

      case "set_summary": {
        const { summary } = parseSetSummaryToolArgs(args);
        await client.setSummary({ id: myId!, session_token: mySession!, summary });
        return { text: `Summary set: "${summary}"` };
      }

      case "check_messages": {
        // Piggyback already polled + injected; nothing extra to do.
        return { text: `Checked inbox.` };
      }

      case "ack_messages": {
        if (!inboxStore) return { text: "Durable inbox is unavailable.", isError: true };
        const messageIds = parseExplicitAckIds(args);
        const result = await acknowledgeDurableMessages({
          store: inboxStore,
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
        return { text: `Acknowledged message IDs: ${result.acknowledged_ids.join(", ") || "none"}.${missing}${warning}` };
      }

      case "wait_for_peer_messages": {
        if (!waitResult?.didWait) {
          return { text: "wait_for_peer_messages did not run.", isError: true };
        }
        if (waitResult.found) {
          return { text: `Peer message(s) arrived while waiting (${waitResult.timeoutMs}ms timeout).` };
        }
        return { text: `No peer messages arrived within ${waitResult.timeoutMs}ms.` };
      }

      case "rename_peer": {
        return renameMutex.runExclusive(async () => {
          const { new_name } = parseRenameToolArgs(args);
          if (!isValidName(new_name)) {
            return { text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.`, isError: true };
          }
          const res = await client.renamePeer({ id: myId!, session_token: mySession!, new_name });
          if (!res.ok) return { text: `Rename failed: ${res.error}`, isError: true };
          const oldName = myName;
          const renamedName = res.name ?? new_name;
          if (stableIdentityKey && myReclaimToken && ownsStableIdentity) {
            try {
              const saved = await savePeerIdentity("codex", stableIdentityKey, {
                name: renamedName,
                reclaim_token: myReclaimToken,
              }, undefined, myReclaimToken, oldName ?? undefined);
              if (!saved) throw new Error("stable identity changed concurrently");
            } catch {
              const rollback = oldName
                ? await client.renamePeer({ id: myId!, session_token: mySession!, new_name: oldName })
                : { ok: false };
              if (rollback.ok) return { text: "Rename could not be persisted and was rolled back.", isError: true };
              myName = renamedName;
              return { text: "Renamed, but durable identity persistence failed; restart recovery is not safe.", isError: true };
            }
          }
          myName = renamedName;
          setTabTitle(`peer:${myName}`);
          return { text: `Renamed to ${myName}` };
        });
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  }, {
    suppressInbox: name === "ack_messages",
    beforeReadQueue: name === "wait_for_peer_messages"
      ? async () => {
          const rawTimeout = (args as { timeout_ms?: unknown } | undefined)?.timeout_ms;
          if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout))) {
            throw new Error("timeout_ms must be a finite number");
          }
          const normalized = rawTimeout === undefined
            ? WAIT_FOR_MESSAGES_DEFAULT_MS
            : Math.max(0, Math.min(WAIT_FOR_MESSAGES_MAX_MS, Math.floor(rawTimeout)));
          const found = await waitForFreshPeerMessages(normalized);
          waitResult = { didWait: true, found, timeoutMs: normalized };
        }
      : undefined,
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

  // Write a placeholder title + arm the keepalive BEFORE register() so
  // there's no "node" window between MCP-spawn and peer-registered.
  // The post-register setTabTitle(`peer:${myName}`) overwrites this.
  setTabTitle("peer:starting");
  startTabTitleKeepalive();

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(isBrokerAlive, brokerScriptUrl);
  const sharedSecret = await waitForSharedSecret();
  client = createClient(BROKER_URL, sharedSecret);

  myCwd = await canonicalizePath(process.cwd());
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

  const requestedName = process.env.PEER_NAME;
  stableIdentityKey = requestedName;
  const storedIdentity = await loadPeerIdentity("codex", requestedName);
  const reg = await client.register({
    peer_type: "codex",
    name: storedIdentity?.name ?? requestedName,
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    reclaim_token: storedIdentity?.reclaim_token,
  });
  ownsStableIdentity = await savePeerIdentity(
    "codex",
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
  inboxStore = new CodexInboxStore({ peerId: myId });
  await inboxStore.init();
  await registerWakeableSessionIfEnabled({
    peerId: myId,
    peerName: myName,
    sessionToken: mySession,
    cwd: myCwd,
    gitRoot: myGitRoot,
    tty,
  });
  setTabTitle(`peer:${myName}`);
  // Note: keepalive was already armed earlier in main(), before register().
  // The setTabTitle above just updates `lastTitle`; the running keepalive
  // will re-assert the new name on its next tick (≤1s).
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
      try { await client.heartbeat({ id: myId, session_token: mySession }); }
      catch (e) { exitIfSessionExpired(e); }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Wire deferred lifecycle cleanup into the earlyKillHandler registered at
  // the top of main(). Intentionally do not acknowledge durable inbox entries
  // and do not unregister (preserves reclaim-by-name window). Timer cleanup only.
  lifecycleCleanup = async () => {
    clearInterval(hb);
    pollStopped = true;
    if (pollTickTimer) clearTimeout(pollTickTimer);
  };
  // Note: all signal handlers + 'exit' handler are already armed at the top
  // of main(), before any setTabTitle() call — so a terminal close during
  // startup also clears the title.
}

async function registerWakeableSessionIfEnabled(opts: {
  peerId: PeerId;
  peerName: string;
  sessionToken: string;
  cwd: string;
  gitRoot: string | null;
  tty: string | null;
}): Promise<void> {
  const hints = await resolveWakeRegistrationHints(opts);
  if (!hints) return;

  const appServerPid = hints.app_server_pid;
  if (!Number.isFinite(appServerPid) || appServerPid <= 0) {
    log("wake registry skipped: invalid app-server pid in launch hints");
    return;
  }

  const now = new Date().toISOString();
  const registry = new WakeRegistry();
  await registry.init();
  await registry.upsert({
    peer_id: opts.peerId,
    peer_name: opts.peerName,
    cwd: opts.cwd,
    git_root: opts.gitRoot,
    tty: opts.tty,
    thread_id: hints.thread_id,
    rollout_path: hints.rollout_path,
    app_server_url: hints.app_server_url,
    app_server_socket_path: hints.app_server_socket_path,
    app_server_pid: appServerPid,
    tui_pid: hints.tui_pid,
    mcp_pid: process.pid,
    broker_session_token_hash: hashBrokerSessionToken(opts.sessionToken),
    status: "ready",
    capabilities: ["app-server-ws"],
    created_at: hints.created_at,
    updated_at: now,
    last_seen_at: now,
  });
  if (hints.claim_id !== "env") {
    await new WakeLaunchClaimStore().consume(hints.claim_id, opts.peerId).catch(() => {});
  }
  log(`wake registry updated for thread ${hints.thread_id}`);
}

async function resolveWakeRegistrationHints(opts: {
  cwd: string;
  tty: string | null;
}): Promise<(CompleteWakeLaunchClaim & { claim_id: string }) | null> {
  if (process.env.AGENT_PEERS_WAKE_ENABLED === "1") {
    const threadId = process.env.AGENT_PEERS_WAKE_THREAD_ID;
    const appServerUrl = process.env.AGENT_PEERS_WAKE_APP_SERVER_URL;
    const appServerPid = Number.parseInt(process.env.AGENT_PEERS_WAKE_APP_SERVER_PID ?? "", 10);
    if (!threadId || !appServerUrl || !Number.isFinite(appServerPid) || appServerPid <= 0) {
      log("wake registry skipped: missing AGENT_PEERS_WAKE_THREAD_ID, AGENT_PEERS_WAKE_APP_SERVER_URL, or AGENT_PEERS_WAKE_APP_SERVER_PID");
      return null;
    }
    const now = new Date().toISOString();
    return {
      claim_id: "env",
      cwd: opts.cwd,
      tty: opts.tty,
      requested_peer_name: process.env.PEER_NAME ?? null,
      app_server_url: appServerUrl,
      app_server_pid: appServerPid,
      app_server_socket_path: process.env.AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH || null,
      thread_id: threadId,
      rollout_path: process.env.AGENT_PEERS_WAKE_ROLLOUT_PATH || null,
      tui_pid: process.ppid > 0 ? process.ppid : null,
      status: "ready",
      created_at: now,
      updated_at: now,
      consumed_by_peer_id: null,
    };
  }

  const claimStore = new WakeLaunchClaimStore();
  return claimStore.findMatching({
    cwd: opts.cwd,
    tty: opts.tty,
    waitMs: 30_000,
    includeConsumed: true,
  });
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
