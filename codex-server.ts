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
//   filters out messages already confirmed delivered, and prepends what's
//   left as a [PEER INBOX] block in the tool response.
//
//   Signal-only preview push (notifications/message)
//   ------------------------------------------------------------------
//   A best-effort MCP log notification fires after each background poll
//   that landed new messages in the queue. It carries ONLY the sender's
//   name + peer_type and a pointer to the next tool call — no body, no
//   reply_action. This gives recent Codex CLI versions a "new message
//   from X arrived, look at your inbox" signal in the live transcript
//   without duplicating the authoritative delivery. It does NOT update
//   any dedupe state — the [PEER INBOX] block (Layer 2) is the one and
//   only "this was shown to the model" trigger.
//
// DEDUPE STATE MACHINE (two sets, confirm-on-next-call):
//
//   - `presentedPendingConfirm` — message_ids included in the CURRENT
//     tool response's [PEER INBOX] block but not yet known-delivered.
//     Populated inside withPiggyback just before return.
//
//   - `seen` — message_ids we're SURE reached the model. Populated at
//     the START of the NEXT tool call (Codex calling us again is the
//     evidence that the previous response cycle landed). Once a message
//     is `seen`, we ack its lease, prune it from the durable queue, and
//     ignore any future re-delivery of the same id.
//
// This splits what was previously a single `seen` set that conflated
// "about to be shown" with "known shown." The earlier code could ack +
// prune a message whose response was aborted before reaching Codex —
// silent loss. The split closes that race: a dropped response leaves the
// message in the durable queue AND outside the `seen` set, so on the
// next tool call (or the next session after a restart) it re-surfaces.
// At-least-once per spec §5.4.
//
// Shutdown: clear timers and exit. Deliberately do NOT flush pendingAcks
// (those messages may not have reached Codex yet — flushing on exit would
// be silent loss). Deliberately do NOT unregister (preserves
// reclaim-by-name). Durable queue stays on disk so a restart within the
// 60s reclaim window picks up exactly where this session left off.

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
import { setTabTitle, clearTabTitle, clearTabTitleSync, startTabTitleKeepalive } from "./shared/tab-title.ts";
import { formatInboxBlock, formatInboxPreview } from "./shared/piggyback.ts";
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

DELIVERY CHANNELS:

  1. \`[PEER INBOX]\` block prepended to ANY agent-peers tool response.
     This is the AUTHORITATIVE delivery — full message body, sender
     identity, reply instructions. When you see it, apply the REACTIVE
     rules above.

  2. A best-effort MCP \`notifications/message\` log push also fires
     on each background poll tick, but current Codex CLI does not
     expose these to the model. Treat the [PEER INBOX] block as your
     only input. Path (2) is future-compatible plumbing.`,
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

// Dedupe state (see top-of-file state-machine comment):
//   - `presentedPendingConfirm`: messages in the CURRENT response's
//     [PEER INBOX] block. Promoted to `seen` at the START of the NEXT call.
//   - `seen`: messages we are SURE reached the model. Only these get their
//     lease acked + are pruned from the durable queue.
const presentedPendingConfirm = new Set<number>();
const seen = new Set<number>();
// Messages for which we already fired a notifications/message push.
// Prevents the 30s poll loop from re-triggering an auto-wake turn for
// the same unread message while the model hasn't called check_messages yet.
const notifiedViaLog = new Set<number>();

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

    // Triage leased messages by dedupe state.
    const freshlyUnread: LeasedMessage[] = [];
    for (const message of leased) {
      if (seen.has(message.id)) {
        // We're certain the model saw this one already (previous tool
        // call's piggyback, confirmed by the call after). The lease just
        // got re-offered because our earlier ack was lost or the lease
        // expired before ack. Close it now — this is safe because the
        // model-delivery evidence is already in hand.
        enqueueAck(message.lease_token);
      } else if (presentedPendingConfirm.has(message.id)) {
        // We drew this into the CURRENT response's [PEER INBOX] block but
        // haven't yet seen the next tool call that would confirm
        // delivery. DO NOT ack (would silently drop if the response was
        // lost). DO NOT re-queue in the durable inbox (would make the
        // piggyback double-surface it within the same call). Just stash
        // the new lease token so next-call confirm-flush closes both old
        // + new leases atomically.
        enqueueAck(message.lease_token);
      } else {
        freshlyUnread.push(message);
      }
    }

    if (freshlyUnread.length === 0) return;

    // Authoritative persistence FIRST — if this fails, we do not push and
    // do not ack; next poll tick retries because the lease will expire at
    // the broker and the message will be re-leased.
    try {
      await inboxStore.queueLeasedMessages(freshlyUnread);
      log(`queued ${freshlyUnread.length} unread peer message(s): ${freshlyUnread.map((msg) => `#${msg.id} from ${msg.from_name}`).join(", ")}`);
    } catch (e) {
      log(`failed to persist unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Best-effort signal-only preview push. Recent Codex CLI versions
    // surface MCP log notifications into the live transcript — this
    // fires a "heads up, message waiting" nudge so the model can decide
    // whether to interrupt current work or finish first. It carries NO
    // body and NO reply cues; full content + reply_action live in the
    // authoritative [PEER INBOX] block in the next tool response. This
    // split avoids the double-reply risk where the model would see the
    // same message twice (once via log, once via piggyback) and send two
    // replies. Failures are non-fatal — the authoritative path still
    // delivers on the next tool call.
    for (const m of freshlyUnread) {
      // Skip if we already pushed a notification for this message. Without
      // this guard, the 30s poll loop re-fires the notification every tick
      // for unread messages, causing the model to auto-wake and loop on
      // the same message repeatedly.
      if (notifiedViaLog.has(m.id)) continue;
      try {
        await mcp.notification({
          method: "notifications/message",
          params: {
            // Use `notice` so patched Codex clients (with the trigger-turn
            // filter) treat this as actionable and wake the session. Routine
            // info/debug logs are intentionally filtered out upstream to
            // avoid spurious turns.
            level: "notice",
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
        notifiedViaLog.add(m.id);
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

  // ------------------------------------------------------------------------
  // STEP 1a — Unconditional ack flush.
  //
  // We always attempt to ack every token in pendingAcks, even when
  // presentedPendingConfirm is empty. pollBrokerIntoQueue's seen-branch
  // stashes re-lease tokens for messages we already confirmed delivered
  // — those must be flushed even in tool calls that don't draw any new
  // inbox items, otherwise the broker re-leases the row forever and it
  // never transitions to acked=1 (perpetually-unacked zombie row per
  // codex review PR #2 round 2).
  //
  // Tokens are removed from pendingAcks only on HTTP success; an
  // exception leaves them for the next call to retry. HTTP success with
  // `acked: 0` at the broker (stale tokens) still counts — the next
  // re-lease will land new tokens in pendingAcks via the seen-branch,
  // and this flush will eventually succeed against the current lease.
  if (pendingAcks.length > 0) {
    const toFlush = pendingAcks.slice();
    try {
      await client.ackMessages({
        id: myId, session_token: mySession, lease_tokens: toFlush,
      });
      for (const tok of toFlush) {
        const idx = pendingAcks.indexOf(tok);
        if (idx !== -1) pendingAcks.splice(idx, 1);
      }
    } catch (e) {
      log(`ack flush failed (will retry next call): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------------
  // STEP 1b — Confirm-promote: items drawn into the PREVIOUS response
  // are now (with Codex calling us again as evidence) known to have
  // reached the model. Prune them from the durable queue and move their
  // ids into `seen`. Pruning can fail independently of the ack above
  // (disk I/O vs broker HTTP); if it does we keep the items in
  // presentedPendingConfirm and retry next call. Partial promotion is
  // not allowed — would re-open the silent-loss window.
  if (presentedPendingConfirm.size > 0) {
    const confirming = [...presentedPendingConfirm];
    try {
      if (inboxStore) await inboxStore.removeByIds(confirming);
      for (const id of confirming) {
        seen.add(id);
        presentedPendingConfirm.delete(id);
        notifiedViaLog.delete(id);
      }
    } catch (e) {
      log(`confirm-flush queue-prune failed (will retry next call): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------------
  // STEP 2 — Inline poll so we pick up anything that arrived in the last
  // POLL_INTERVAL_MS window. Background loop does the same thing on a
  // timer; calling it here collapses the worst-case "message landed 0.99s
  // before this tool call" tail.
  try {
    await pollBrokerIntoQueue();
  } catch (e) {
    log(`inline poll failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ------------------------------------------------------------------------
  // STEP 3 — Read (do NOT consume) the durable queue. Items stay on disk
  // until the NEXT call's confirm-flush promotes them to `seen` and
  // removes them. A dropped response thus leaves the message in place
  // for re-delivery, fixing the silent-loss race the codex-reviewer bot
  // flagged on PR #2 round 1.
  let queued: LeasedMessage[] = [];
  try {
    queued = inboxStore ? await inboxStore.getUnreadMessages() : [];
  } catch (e) {
    log(`failed to read unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Filter out anything already confirmed delivered (defensive — the
  // durable queue shouldn't contain `seen` ids, but pollBrokerIntoQueue's
  // seen-branch guarantees it) and anything we already drew into an
  // earlier-but-unconfirmed response (presentedPendingConfirm). The
  // latter can happen if the previous call's confirm-flush partially
  // failed above; we want to keep showing the same items until flush
  // succeeds, not start dealing duplicates.
  const fresh: LeasedMessage[] = [];
  for (const m of queued) {
    if (seen.has(m.id)) continue;
    if (presentedPendingConfirm.has(m.id)) {
      // Already showed this in an earlier response whose confirm-flush
      // hasn't completed yet. Skip re-drawing — the earlier presentation
      // is still the one we're waiting to confirm.
      continue;
    }
    fresh.push(m);
  }

  // Mark fresh items as "presented this call, awaiting confirm" and
  // stash their lease tokens for the NEXT call's confirm-flush. This is
  // the single write point where a message transitions from "sitting in
  // queue" to "shown to the model."
  for (const m of fresh) {
    presentedPendingConfirm.add(m.id);
    enqueueAck(m.lease_token);
  }

  // ------------------------------------------------------------------------
  // STEP 4 — Run the tool handler + build the response.
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

  // Write a placeholder title + arm the keepalive BEFORE register() so
  // there's no "node" window between MCP-spawn and peer-registered.
  // The post-register setTabTitle(`peer:${myName}`) overwrites this.
  setTabTitle("peer:starting");
  startTabTitleKeepalive();

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
