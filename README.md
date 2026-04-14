# agent-peers-mcp

**Let your Claude Code and Codex CLI sessions talk to each other.**

Run multiple AI coding agents in parallel (Claude in one tab, Codex in another, a second Claude in a third) and any of them can discover the others, send messages, and coordinate work — all on localhost, no cloud.

```
  Terminal 1 (Claude)           Terminal 2 (Codex)           Terminal 3 (Claude)
  ┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
  │ "Send to peer    │────────> │ ← [PEER INBOX]   │         │ ← <channel push> │
  │  backend-codex:  │          │  respond via     │<────────│  "can you check  │
  │  what's the DB   │          │  send_message    │         │   the auth bug?" │
  │  schema?"        │<─────────│                  │         │                  │
  └──────────────────┘          └──────────────────┘         └──────────────────┘
                 \\                    |                          /
                  \\                   v                         /
                   └───── broker on localhost:7900 ─────────────┘
                              (SQLite + HTTP daemon)
```

Built as a hardened, security-reviewed successor to [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with Codex CLI support added.

---

## Quickstart

```bash
git clone https://github.com/Co-Messi/agent-peers-mcp.git
cd agent-peers-mcp
bun install
```

Then register the MCP in both Claude Code and Codex CLI (see [Install](#install) below), open two terminal tabs, and ask one session:

> "List all peers on this machine, then send a message to the first one."

You're done.

---

## What this gives you

| Feature | Description |
|---|---|
| **Instant Claude ↔ Claude** | Messages arrive mid-task via Claude Code's `claude/channel` push protocol. |
| **Codex ↔ Codex / Claude ↔ Codex** | Messages piggyback on Codex's next tool call — no polling, zero token waste when idle. |
| **Human-readable names** | Each peer gets a friendly name like `calm-fox`, or set your own via `PEER_NAME=frontend-tab`. Terminal tab titles update automatically so you can tell sessions apart. |
| **Self-rename** | Any peer can rename itself via the `rename_peer` tool. |
| **Scoped discovery** | Filter peers by machine, working directory, or git repo. |
| **Session-token auth** | Each peer gets an unforgeable session token. One peer can't impersonate, drain, or rename another. |
| **Lease + ack delivery** | Messages are leased for 30s; lost acks trigger re-delivery with in-memory dedupe. |
| **Orphan observability** | If a recipient dies before reading, the message surfaces via `cli.ts orphaned-messages` — never silently lost. |
| **Schema migrations** | Upgrading the broker auto-migrates old databases transactionally. |

---

## Install

### Step 1 — Clone and install deps

```bash
git clone https://github.com/Co-Messi/agent-peers-mcp.git
cd agent-peers-mcp
bun install
```

Keep this terminal open inside `agent-peers-mcp/` — the setup commands below use `$(pwd)` to fill in the absolute path automatically, so **you don't have to edit anything**.

---

### Step 2a — Set up for Claude Code

Run this **from inside the `agent-peers-mcp/` directory** — it's a single block you can copy-paste verbatim:

```bash
# Register the MCP globally for Claude Code
claude mcp add --scope user --transport stdio agent-peers -- \
  bun "$(pwd)/claude-server.ts"

# Add the launcher alias to your shell rc
echo "
# agent-peers-mcp
alias agentpeers='claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'
" >> ~/.zshrc

# Reload
source ~/.zshrc
```

**Test it:** open a new terminal and run `agentpeers` — Claude starts with the peer network loaded.

---

### Step 2b — Set up for Codex CLI

Also run this **from inside the `agent-peers-mcp/` directory** — a single block, copy-paste verbatim:

```bash
# Append the MCP config to Codex's config.toml (creates the file if missing)
cat >> ~/.codex/config.toml <<EOF

[mcp_servers.agent-peers]
command = "bun"
args = ["$(pwd)/codex-server.ts"]
EOF
```

**Test it:** open a new terminal and run `codex` — Codex launches with agent-peers available.

---

### Step 3 — Try it out

1. **Terminal 1:** `PEER_NAME=alpha agentpeers`
2. **Terminal 2:** `PEER_NAME=beta codex`
3. In either session, ask: **"List all peers on this machine"** — you should see the other one.
4. In one session, ask: **"Send a message to peer alpha: hello from beta"**
5. The other session should receive the message (instant for Claude via channel push, on its next tool call for Codex).

Done.

---

## Usage

### Launch peer-aware sessions

```bash
# Claude with a friendly name
PEER_NAME=frontend-tab agentpeers

# Claude with auto-generated name (like "calm-fox")
agentpeers

# Codex picks up the MCP automatically
codex

# Codex with a pre-assigned name
PEER_NAME=backend-work codex
```

Each tab's title updates to `peer:<name>` so you can tell sessions apart at a glance.

### Talk between sessions

Inside any session, ask the agent:

> "List all peers on this machine"

> "Send a message to peer frontend-tab: can you handle the UI while I work on the API?"

> "Rename me to architect"

> "Only show me Codex peers in this repo"

### Inspect from the shell

```bash
bun cli.ts status                        # Broker + full peer list
bun cli.ts peers                         # Peers only
bun cli.ts send frontend-tab "ship it"   # Send from the shell
bun cli.ts rename calm-fox docs-writer   # Admin rename
bun cli.ts orphaned-messages             # Messages to peers that died
bun cli.ts kill-broker                   # Stop the broker daemon
```

---

## How it works

- **Broker daemon** (`broker.ts`) runs on `localhost:7900` with SQLite at `~/.agent-peers.db`. Auto-launches on first session.
- **Each session** spawns an MCP server (`claude-server.ts` or `codex-server.ts`) that registers with the broker.
- **Claude sessions** poll the broker every 1s and push inbound messages via `notifications/claude/channel` → Claude sees the message mid-task.
- **Codex sessions** piggyback on tool calls: every tool handler's response is prepended with pending peer messages as a `[PEER INBOX]` block. Zero polling overhead when idle.
- **Sessions gracefully restart**: if you SIGKILL a session and restart with the same `PEER_NAME` within 60s, the broker reclaims the same UUID and undelivered messages route correctly (at-least-once).

Read the full technical spec at [`docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md`](docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md).

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PEERS_PORT` | `7900` | Broker port |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | SQLite path |
| `PEER_NAME` | auto-generated | Human-readable peer name at launch (1-32 chars, `[a-zA-Z0-9_-]`) |
| `OPENAI_API_KEY` | — | Enables `gpt-5.4-nano` auto-summary of what each session is working on |
| `AGENT_PEERS_DISABLE_TAB_TITLE` | — | Set to `1` to skip terminal tab title writing |

---

## Troubleshooting

**"No other peers found"**
Make sure at least two sessions are running with the MCP loaded. Run `bun cli.ts status` from a third shell to confirm the broker sees them.

**Broker port 7900 already in use**
Kill any old broker: `bun cli.ts kill-broker`. If another process owns the port, set `AGENT_PEERS_PORT=7901` in your env.

**Codex doesn't see the inbox**
Ask it to call `list_peers` or `check_messages` — messages surface on any MCP tool call, not just specific ones. If you still don't see the `[PEER INBOX]` block, your Codex version may not render tool responses verbatim; file an issue with your Codex version.

**Upgraded from an older install and existing peers aren't working**
The broker migrates pre-session-token databases by dropping all legacy peer rows (they can't authenticate under the new scheme). Restart all your sessions to re-register. Any in-flight messages for the dropped peers are visible via `bun cli.ts orphaned-messages`.

**Running alongside upstream `claude-peers-mcp`**
They coexist cleanly on different ports (7900 vs 7899) and different MCP names (`agent-peers` vs `claude-peers`). You can use both simultaneously; they don't share state.

---

## Architecture

```
agent-peers-mcp/
├── broker.ts                                  # HTTP+SQLite daemon (7900)
├── claude-server.ts                           # MCP server with channel push
├── codex-server.ts                            # MCP server with piggyback
├── cli.ts                                     # Admin / inspection CLI
├── shared/
│   ├── types.ts                               # API types
│   ├── broker-client.ts                       # Typed HTTP client
│   ├── ensure-broker.ts                       # Auto-spawn helper
│   ├── peer-context.ts                        # git root / tty / pid
│   ├── tab-title.ts                           # OSC terminal title
│   ├── summarize.ts                           # gpt-5.4-nano auto-summary
│   ├── piggyback.ts                           # [PEER INBOX] formatter
│   └── names.ts                               # adjective-noun generator
├── tests/                                     # 59 tests — broker, migration, piggyback, client, names
└── docs/superpowers/
    ├── specs/2026-04-13-agent-peers-mcp-design.md      # Full spec (post 7 review rounds)
    └── plans/2026-04-13-agent-peers-mcp-implementation.md
```

---

## Coexistence with upstream `claude-peers-mcp`

|  | upstream `claude-peers-mcp` | this `agent-peers-mcp` |
|---|---|---|
| Broker port | 7899 | 7900 |
| SQLite | `~/.claude-peers.db` | `~/.agent-peers.db` |
| MCP name | `claude-peers` | `agent-peers` |
| Alias | `claudedpeers` | `agentpeers` |
| Codex support | No | Yes |
| Session-token auth | No | Yes |
| Orphan observability | No | Yes |
| Self-rename tool | No | Yes |

Both can run simultaneously. They do not talk to each other — you'd run `claudedpeers` for the upstream network and `agentpeers` for this one.

---

## Delivery contract

**Within a single session** — deterministic dedupe by `message_id` via in-memory seen-set. Same message is never delivered twice while your process is alive.

**Across a process restart** that reclaims the same UUID (via `PEER_NAME` within the 60-90s GC window) — **at-least-once**. A message polled but not acked before a crash may be re-delivered once. Replies should be idempotent.

**When a recipient dies before delivery** — messages are preserved in the broker DB as **orphans**, visible via `bun cli.ts orphaned-messages`. Never silently lost.

**Peer-to-peer security** — every peer gets a session token on register. Wrong token → operation silently no-ops (heartbeat / set_summary / unregister) or explicitly rejects (send / poll / ack / rename). You cannot impersonate, drain, or rename another peer via the MCP.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Claude Code](https://claude.ai/code) v2.1.80+ (for channel push)
- [OpenAI Codex CLI](https://github.com/openai/codex-cli) (for the Codex side)
- macOS or Linux (tested on macOS Darwin; Linux should work but untested)

---

## License

MIT. See `LICENSE`.

---

## Contributing

Issues and PRs welcome at https://github.com/Co-Messi/agent-peers-mcp.

If you want to propose a change, please read `docs/superpowers/specs/` first — the full design rationale and rejected alternatives are documented there.
