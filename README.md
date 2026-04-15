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
| **Codex ↔ Codex / Claude ↔ Codex** | Codex keeps a background-polled local inbox, then surfaces queued messages on the next agent-peers response as a `[PEER INBOX]` block. |
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

4. Append the launcher alias to ~/.zshrc (skip if it's already there — don't duplicate).

   CRITICAL — the alias MUST start with `AGENT_PEERS_ENABLED=1`. Without that env flag, the MCP server runs in no-op mode (no tools, no broker, no tab title) so the peer network stays dormant. The whole point of the alias is to set this flag only when launching `agentpeers`, leaving plain `claude` untouched:
   alias agentpeers='AGENT_PEERS_ENABLED=1 claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'

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
   env = { "AGENT_PEERS_ENABLED" = "1" }
   Substitute $AGENT_PEERS_DIR with the real absolute path before writing.

   CRITICAL — do NOT omit the `env = { "AGENT_PEERS_ENABLED" = "1" }` line. Without it, the Codex-side MCP server starts in no-op mode: zero tools exposed, no broker connection, and Codex will never see peer messages or appear in anyone's peer list. Setting this env flag to "1" is what activates the peer network.

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
| **Codex** | After background polling queues it locally, on the next agent-peers response as a `[PEER INBOX]` block |

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
- **Codex sessions** also poll every 1s, but instead of a client push channel they store unread messages in a local inbox queue and surface them as a `[PEER INBOX]` block on the next agent-peers response.
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

## Known behaviors

**Claude sessions only activate peers when you launch via `agentpeers`.**
The `agentpeers` alias sets `AGENT_PEERS_ENABLED=1`. Plain `claude` does not, so the MCP loads in idle/no-op mode — no peer registration, no tab title change, no broker connection. This is intentional: the MCP is registered globally in `~/.claude.json`, so every `claude` session spawns it, and we don't want the peer network showing up in unrelated sessions.

**Codex always has peers active** (as long as you included `env = { "AGENT_PEERS_ENABLED" = "1" }` in your `config.toml` entry). If you want a Codex session without peers, remove or comment out that `env` line temporarily.

**Codex keeps a local peer inbox warm in the background.**
There is still no native Codex push channel, so queued peer messages surface on the next response from an agent-peers tool (`list_peers`, `send_message`, `set_summary`, `check_messages`, or `rename_peer`). The difference is that unread messages are already being polled and refreshed in the background, so they wait in Codex's local inbox instead of only at the broker. Ask Codex "check messages" when you want that inbox surfaced immediately.

**Closed tabs disappear from discovery within ~60 seconds.**
When you close a tab, the shell kills the session without graceful cleanup. The peer row stays in the broker until its heartbeat goes stale (~60s). `list_peers` filters stale peers out of results immediately — you won't see ghost peers there even in that window. If you restart with the same `PEER_NAME` within 60-90s, the broker reclaims the same UUID and any undelivered messages route correctly.

---

## Troubleshooting

**"No other peers found"**
Make sure at least two sessions are running with the MCP loaded. Run `bun cli.ts status` from a third shell to confirm the broker sees them.

**Broker port 7900 already in use**
Kill any old broker: `bun cli.ts kill-broker`. If another process owns the port, set `AGENT_PEERS_PORT=7901` in your env.

**Codex doesn't see the inbox**
Ask it to call `list_peers` or `check_messages` — messages surface on any agent-peers tool response, not just specific ones. If you still don't see the `[PEER INBOX]` block, your Codex version may not render tool responses verbatim; file an issue with your Codex version.

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

## Update (pull latest version)

Two upgrade prompts below — parallel to Install / Uninstall. Each is a plain-English prompt you paste into your agent, and the agent performs a safe in-place upgrade: stops the broker, pulls the latest code from this repo, reinstalls dependencies, runs the test suite as a sanity check, and tells you to restart your sessions so the new code is loaded.

---

### 🧠 For Claude Code — paste this to update

Open a Claude Code session and paste this verbatim:

````
Update agent-peers-mcp to the latest version on my machine.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to update before proceeding. Do NOT modify anything until I confirm.

Once I confirm the path, do all of the following in order:

1. cd into the confirmed install directory.

2. Stop any running broker daemon so the upgrade can replace files cleanly:
   - Run `lsof -t -i:7900` to find broker PIDs.
   - Kill each with `kill -TERM <pid>` (SIGKILL after 2s if needed).
   - Also try `bun cli.ts kill-broker` as a fallback.

3. Record the current commit SHA for rollback reference:
   `git rev-parse --short HEAD` — save the value so you can tell me later.

4. DIRTY WORKTREE CHECK — before any destructive git action:
   Run `git status --porcelain`. If it produces ANY output (modified, added, or untracked files), STOP. Show me the output and ask whether I want to: (a) stash my changes and proceed, (b) abort the update, or (c) blow the changes away with a hard reset. Do NOT proceed to step 5 until I answer.
   If `git status --porcelain` is empty, continue.

5. Pull the latest code. Prefer a fast-forward pull so accidental rebases or divergent local commits surface as an error rather than a silent clobber:
   `git fetch origin main && git pull --ff-only origin main`
   If that fails (e.g. because we chose "blow away changes" in step 4, or local commits diverged), fall back to `git reset --hard origin/main` — but only after explicit confirmation.

6. Refresh dependencies:
   `bun install`

7. Run the test suite as a sanity check:
   `bun test`
   If any test fails, STOP and show me the failure output — do NOT tell me the update is complete.

8. Print a summary: old commit SHA, new commit SHA, the short-log between them (`git log --oneline <old>..HEAD`), and what tests passed.

9. Tell me to close and relaunch any running `agentpeers` and `codex` sessions so the new MCP server code is loaded. Existing sessions keep running the OLD code until they restart.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

---

### 🤖 For Codex — paste this to update

Open a Codex session and paste this verbatim:

````
Update agent-peers-mcp to the latest version on my machine.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to update before proceeding. Do NOT modify anything until I confirm.

Once I confirm the path, do all of the following in order:

1. cd into the confirmed install directory.

2. Stop any running broker daemon so the upgrade can replace files cleanly:
   - Run `lsof -t -i:7900` to find broker PIDs.
   - Kill each with `kill -TERM <pid>` (SIGKILL after 2s if needed).
   - Also try `bun cli.ts kill-broker` as a fallback.

3. Record the current commit SHA for rollback reference:
   `git rev-parse --short HEAD` — save the value so you can tell me later.

4. DIRTY WORKTREE CHECK — before any destructive git action:
   Run `git status --porcelain`. If it produces ANY output (modified, added, or untracked files), STOP. Show me the output and ask whether I want to: (a) stash my changes and proceed, (b) abort the update, or (c) blow the changes away with a hard reset. Do NOT proceed to step 5 until I answer.
   If `git status --porcelain` is empty, continue.

5. Pull the latest code. Prefer a fast-forward pull so accidental rebases or divergent local commits surface as an error rather than a silent clobber:
   `git fetch origin main && git pull --ff-only origin main`
   If that fails (e.g. because we chose "blow away changes" in step 4, or local commits diverged), fall back to `git reset --hard origin/main` — but only after explicit confirmation.

5. Refresh dependencies:
   `bun install`

6. Run the test suite as a sanity check:
   `bun test`
   If any test fails, STOP and show me the failure output — do NOT tell me the update is complete.

7. Print a summary: old commit SHA, new commit SHA, the short-log between them (`git log --oneline <old>..HEAD`), and what tests passed.

9. Tell me to close and relaunch any running Claude `agentpeers` and Codex sessions so the new MCP server code is loaded. Existing sessions keep running the OLD code until they restart.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

---

## Uninstall

Two uninstall prompts below — parallel to the install pair. Each is a plain-English prompt you paste into the agent, and the agent removes everything it installed. Each prompt first asks you to confirm the clone path (in case the agent is in a fresh session and doesn't remember where it was cloned to).

---

### 🧠 For Claude Code — paste this to uninstall

Open a Claude Code session and paste this verbatim:

````
Completely uninstall agent-peers-mcp for me — I want every trace gone.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to remove before proceeding. Do NOT delete anything until I confirm.

Once I confirm the path, do a FULL wipe — do not ask per-item confirmations; just do everything:

1. Stop any running broker daemon:
   - Run `lsof -t -i:7900` to find the broker PID(s).
   - Kill each one with `kill -TERM <pid>` (or SIGKILL if SIGTERM doesn't work within 2s).
   - Also run `bun cli.ts kill-broker` from inside the confirmed repo directory if the repo still exists at this point — it's another way to stop the broker.

2. Unregister the MCP from Claude Code:
   claude mcp remove agent-peers

3. Remove the launcher alias from ~/.zshrc. The line looks like:
   alias agentpeers='AGENT_PEERS_ENABLED=1 claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'
   Delete that line (and any surrounding "# agent-peers-mcp" comment). Leave every other line in ~/.zshrc untouched.

4. Delete the cloned repo directory (the exact path I confirmed in Step 1) — remove recursively.

5. Delete ALL broker state files under my home directory. Specifically any file matching `~/.agent-peers*` — this normally means:
   - ~/.agent-peers.db
   - ~/.agent-peers.db-shm
   - ~/.agent-peers.db-wal
   Use `rm -f ~/.agent-peers.db ~/.agent-peers.db-shm ~/.agent-peers.db-wal` so missing files don't error. Also run `ls -la ~/.agent-peers* 2>/dev/null` afterwards to confirm nothing is left.

6. Tell me to run `source ~/.zshrc` (or open a new terminal) so the alias change takes effect.

7. Give me a final summary listing every path and resource you removed, plus anything you couldn't remove and why. Also paste the output of `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` so I can see it's fully gone.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

---

### 🤖 For Codex — paste this to uninstall

Open a Codex session and paste this verbatim:

````
Completely uninstall agent-peers-mcp for me — I want every trace gone.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to remove before proceeding. Do NOT delete anything until I confirm.

Once I confirm the path, do a FULL wipe — do not ask per-item confirmations; just do everything:

1. Stop any running broker daemon:
   - Run `lsof -t -i:7900` to find the broker PID(s).
   - Kill each one with `kill -TERM <pid>` (or SIGKILL if SIGTERM doesn't work within 2s).
   - Also run `bun cli.ts kill-broker` from inside the confirmed repo directory if the repo still exists at this point — it's another way to stop the broker.

2. Remove the [mcp_servers.agent-peers] block from ~/.codex/config.toml. Keep every other mcp_servers entry and every other section intact. If you are not 100% certain you can surgically edit TOML, FIRST show me the exact block you intend to remove and ask me to confirm before writing.

3. Delete the cloned repo directory (the exact path I confirmed in Step 1) — remove recursively.

4. Delete ALL broker state files under my home directory. Specifically any file matching `~/.agent-peers*` — this normally means:
   - ~/.agent-peers.db
   - ~/.agent-peers.db-shm
   - ~/.agent-peers.db-wal
   Use `rm -f ~/.agent-peers.db ~/.agent-peers.db-shm ~/.agent-peers.db-wal` so missing files don't error. Also run `ls -la ~/.agent-peers* 2>/dev/null` afterwards to confirm nothing is left.

5. Give me a final summary listing every path and resource you removed, plus anything you couldn't remove and why. Also paste the output of `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` so I can see it's fully gone.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

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
