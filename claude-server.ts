#!/usr/bin/env bun
// claude-server.ts
// MCP stdio server for Claude Code. Registers as peer_type="claude", declares
// claude/channel, pushes inbound messages instantly via channel notifications.
//
// Delivery pipeline: every 1s the polling loop leases any new messages from the
// broker, pushes each via mcp.notification(...), adds successfully-pushed
// message_ids to an in-memory seen-set, and batches the corresponding lease
// tokens for a single /ack-messages call. Re-deliveries (lease expired and
// re-leased) are detected via seen-set and acked without a duplicate push.
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

import { createClient } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { waitForSharedSecret } from "./shared/shared-secret.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle, clearTabTitle, clearTabTitleSync } from "./shared/tab-title.ts";
import { isValidName } from "./shared/names.ts";
import { COLLEAGUE_PROTOCOL } from "./shared/colleague-prompt.ts";
import type { PeerId } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the protocol).
  console.error(`[agent-peers/claude] ${msg}`);
}

// The shared secret is only known after the broker has provisioned it, so
// we defer client construction until main() can read the secret file.
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

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `${COLLEAGUE_PROTOCOL}

DELIVERY ON THIS SIDE (Claude Code): peer messages arrive instantly via
\`<channel source="agent-peers" ...>\` push notifications. You do NOT need
to poll — \`check_messages\` is a no-op here, kept only for protocol
symmetry with Codex peers. When you see a channel push, apply the
REACTIVE rules above.`,
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
      "Passive helper. Messages from peers arrive automatically via the agent-peers channel push — you normally do not need to call this.",
    inputSchema: { type: "object" as const, properties: {} },
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
      const { scope, peer_type } = args as {
        scope: "machine" | "directory" | "repo";
        peer_type?: "claude" | "codex";
      };
      const peers = await client.listPeers({
        scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId, peer_type,
      });
      if (peers.length === 0) {
        return { content: [{ type: "text" as const, text: `No other peers found (scope: ${scope}).` }] };
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
      return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` }] };
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      const res = await client.sendMessage({
        from_id: myId, session_token: mySession, to_id_or_name: to_id, text: message,
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Send failed: ${res.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Message sent (id=${res.message_id}).` }] };
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      await client.setSummary({ id: myId, session_token: mySession, summary });
      return { content: [{ type: "text" as const, text: `Summary set: "${summary}"` }] };
    }

    case "check_messages": {
      // Deliberately do NOT poll+ack inside this handler (spec §5.4).
      // That would ack before the tool response is confirmed delivered to Claude.
      // The background pollAndPush loop owns delivery + ack via the channel push
      // path, which is the one place ack actually fires and is gated on
      // successful mcp.notification() resolution.
      return {
        content: [{
          type: "text" as const,
          text: "Messages arrive automatically via the agent-peers channel. If you have not seen one recently, none are pending.",
        }],
      };
    }

    case "rename_peer": {
      const { new_name } = args as { new_name: string };
      if (!isValidName(new_name)) {
        return {
          content: [{ type: "text" as const, text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.` }],
          isError: true,
        };
      }
      const res = await client.renamePeer({ id: myId, session_token: mySession, new_name });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Rename failed: ${res.error}` }], isError: true };
      }
      myName = res.name ?? new_name;
      setTabTitle(`peer:${myName}`);
      return { content: [{ type: "text" as const, text: `Renamed to ${myName}` }] };
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

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(isBrokerAlive, brokerScriptUrl);
  // Now that the broker is up, read the per-user shared secret it wrote into
  // ~/.agent-peers-secret (file mode 0600) and construct an authenticated
  // HTTP client with it.
  const sharedSecret = await waitForSharedSecret();
  client = createClient(BROKER_URL, sharedSecret);

  myCwd = process.cwd();
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

  const reg = await client.register({
    peer_type: "claude",
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

  // In-memory dedupe: message_ids we have already pushed successfully this session.
  // See spec §5.4 for rationale — deterministic dedupe, no model intelligence required.
  const seen = new Set<number>();

  const pollAndPush = async () => {
    if (!myId || !mySession) return;
    try {
      const msgs = await client.pollMessages({ id: myId, session_token: mySession });
      const toAck: string[] = [];
      for (const m of msgs) {
        if (seen.has(m.id)) {
          // Re-delivery after lost ack. Queue the new lease_token so the broker
          // can close the stuck lease, but do NOT push again.
          toAck.push(m.lease_token);
          continue;
        }
        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: m.text,
              meta: {
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
          // Mark delivered in seen BEFORE queueing the ack so a later ack
          // failure cannot cause a re-push within this session.
          seen.add(m.id);
          toAck.push(m.lease_token);
        } catch (e) {
          log(`push failed (lease will expire + redeliver): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (toAck.length > 0 && mySession) {
        try {
          await client.ackMessages({ id: myId, session_token: mySession, lease_tokens: toAck });
        } catch {
          /* next poll picks up remainder */
        }
      }
    } catch (e) {
      log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Self-scheduling loop with re-entrancy guard (code review round-1 fix).
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
      try { await client.heartbeat({ id: myId, session_token: mySession }); } catch { /* non-critical */ }
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
