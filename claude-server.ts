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
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle } from "./shared/tab-title.ts";
import { isValidName } from "./shared/names.ts";
import type { PeerId } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the protocol).
  console.error(`[agent-peers/claude] ${msg}`);
}

const client = createClient(BROKER_URL);

let myId: PeerId | null = null;
let myName: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the agent-peers network. Other AI agents on this machine (Claude Code or Codex CLI) can see you and send you messages.

IMPORTANT: When you receive a <channel source="agent-peers" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply via send_message with the sender's from_id (or from_name), then resume.

On startup, proactively call set_summary with a 1-2 sentence description of your work.

Available tools:
- list_peers(scope: machine|directory|repo, peer_type?)
- send_message(to_id, message)  // to_id accepts a peer UUID or a human name
- set_summary(summary)
- check_messages  // passive helper; messages arrive automatically via channel
- rename_peer(new_name)  // renames YOU; 1-32 chars, [a-zA-Z0-9_-]`,
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
  if (!myId) {
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
        from_id: myId, to_id_or_name: to_id, text: message,
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Send failed: ${res.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Message sent (id=${res.message_id}).` }] };
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      await client.setSummary({ id: myId, summary });
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
      const res = await client.renamePeer({ id: myId, new_name });
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
  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(client, brokerScriptUrl);

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
  setTabTitle(`peer:${myName}`);
  log(`Registered as ${myName} (id=${myId})`);

  // Late summary upload if generation took longer than 3s.
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await client.setSummary({ id: myId, summary: initialSummary });
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
    if (!myId) return;
    try {
      const msgs = await client.pollMessages(myId);
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
      if (toAck.length > 0) {
        try {
          await client.ackMessages({ id: myId, lease_tokens: toAck });
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
    if (myId) {
      try { await client.heartbeat(myId); } catch { /* non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(hb);
    pushStopped = true;
    if (pushTickTimer) clearTimeout(pushTickTimer);
    // Deliberately NO client.unregister(myId) here.
    // Unregister would immediately delete the peer row and defeat the
    // reclaim-by-name mechanism in /register that lets a restart with the same
    // PEER_NAME preserve the UUID. The broker's 30-second GC reaps us within
    // 60-90s of our heartbeat stopping.
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(async (e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  // If we registered with the broker but failed BEFORE mcp.connect() or before
  // signal handlers were installed, no active session exists to preserve for
  // reclaim. Unregister explicitly so the row doesn't block same-name reclaim
  // for 60s. Post-connect failures use the signal-handler path (no unregister).
  if (myId) {
    try { await client.unregister(myId); } catch { /* best effort */ }
  }
  process.exit(1);
});
