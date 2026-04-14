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

Two install prompts below — one for Claude Code, one for Codex. Each is a plain-English prompt you paste into the agent, and the agent installs everything itself. Pick either or do both.

---

### 🧠 For Claude Code

Open a Claude Code session and paste this verbatim:

````
Install https://github.com/Co-Messi/agent-peers-mcp for me.

First, fetch its README from that repo URL and read it so you understand what the project is and why I want it installed.

Then do all of the following:

1. Clone the repo to a sensible location on my machine (prefer `~/Github Repos/agent-peers-mcp` if that parent directory exists, otherwise `~/agent-peers-mcp`). Remember the absolute path as $AGENT_PEERS_DIR.

2. cd into $AGENT_PEERS_DIR and run `bun install`.

3. Register the MCP globally for Claude Code by running:
   claude mcp add --scope user --transport stdio agent-peers -- bun "$AGENT_PEERS_DIR/claude-server.ts"

4. Append the launcher alias to ~/.zshrc (skip if it's already there — don't duplicate):
   alias agentpeers='claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'

5. Tell me the install is done and I should:
   - `source ~/.zshrc` (or open a new terminal)
   - Launch another tab with `PEER_NAME=my-name agentpeers`
   - Ask the new session to "list all peers on this machine"

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

---

### 🤖 For Codex

Open a Codex session and paste this verbatim:

````
Install https://github.com/Co-Messi/agent-peers-mcp for me.

First, fetch its README from that repo URL and read it so you understand what the project is and why I want it installed.

Then do all of the following:

1. Clone the repo to a sensible location on my machine (prefer `~/Github Repos/agent-peers-mcp` if that parent directory exists, otherwise `~/agent-peers-mcp`). Remember the absolute path as $AGENT_PEERS_DIR.

2. cd into $AGENT_PEERS_DIR and run `bun install`.

3. Append this block to ~/.codex/config.toml (create the file if it doesn't exist; skip if the [mcp_servers.agent-peers] section already exists):
   [mcp_servers.agent-peers]
   command = "bun"
   args = ["$AGENT_PEERS_DIR/codex-server.ts"]
   Substitute $AGENT_PEERS_DIR with the real absolute path before writing.

4. Tell me the install is done and I should:
   - Open a new terminal and run `codex` — the MCP will load automatically
   - Optionally set `PEER_NAME=my-name` before launching for a stable name
   - Ask the new session to "list all peers on this machine"

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

---

---

## Usage

Four steps: **launch → name → test → talk**. Pick the path for each agent you want to run — Claude, Codex, or both.

### Step 1 — Launch a peer-aware session

Open a new terminal and run the launcher for your agent:

| Agent | Command |
|---|---|
| **Claude Code** | `agentpeers` |
| **Codex** | `codex` |

That's it — the MCP loads automatically, the broker auto-spawns if it's not already running, and your terminal tab renames itself to `peer:<name>`.

### Step 2 — Name your session (optional but recommended)

Every session gets a random friendly name on launch (like `calm-fox`, `swift-panda`). If you want a stable, human-readable name, set `PEER_NAME` **before** the launcher:

| Agent | Command |
|---|---|
| **Claude Code** | `PEER_NAME=frontend-tab agentpeers` |
| **Codex** | `PEER_NAME=backend-work codex` |

**Name rules:** 1–32 characters, `[a-zA-Z0-9_-]` only, must be unique across currently-live peers. A name collision auto-suffixes (`frontend-tab` → `frontend-tab-2`).

**Rename mid-session:** just ask the agent — for example, "rename me to architect" — and the `rename_peer` tool fires. Your tab title updates to the new name immediately.

### Step 3 — Test that the network is alive

Open **two** terminal tabs and launch a session in each (any combination of Claude + Codex). In either session, ask:

> **"List all peers on this machine"**

You should see the other session. Then, in one of them, ask:

> **"Send a message to peer \<name\>: hello"**

The other session receives it:

| Recipient | How the message arrives |
|---|---|
| **Claude** | Instantly, mid-task, as a `<channel source="agent-peers">` push |
| **Codex** | In the response of its next tool call, as a `[PEER INBOX]` block |

### Step 4 — Actually use it

Here are prompts that work well once the network is up:

**Coordinate a task:**
> "Send a message to peer backend-work: I'm updating the auth interface in `auth.ts` — can you update the backend to match?"

**Ask for a second opinion:**
> "Send a message to peer code-reviewer: review my last commit and tell me what's wrong"

**Filter discovery:**
> "List only the Codex peers in this repo"

**Check summaries:**
> "List all peers and tell me what each one is working on" — each peer advertises a `summary` you can read.

---

## Shell CLI

Inspect and control the broker from a terminal (no Claude/Codex session needed):

```bash
bun cli.ts status                        # Broker health + full peer list
bun cli.ts peers                         # Peers only
bun cli.ts send frontend-tab "ship it"   # Send a message from the shell
bun cli.ts rename calm-fox docs-writer   # Admin rename (operator action)
bun cli.ts orphaned-messages             # Messages to peers that died
bun cli.ts kill-broker                   # Stop the broker daemon
```

Run these from inside the cloned `agent-peers-mcp/` directory.

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
