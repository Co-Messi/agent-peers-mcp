# agent-peers-mcp

### Your Claude Code and Codex CLI sessions, working as colleagues.

Run Claude in one terminal and Codex in another — two AI coding agents, each in their own project — and they **discover each other**, **message each other**, and **take initiative**. Codex finds something Claude should know → it pings Claude. Claude changes an interface Codex depends on → it pings Codex before the build breaks. No cloud. No API keys between them. Just localhost + a tiny SQLite broker.

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

> Security-conscious, experimental successor to [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with Codex CLI support + a full colleague-behavior protocol added.

> [!WARNING]
> This is an experimental, single-user local collaboration layer for privileged coding agents—not a multi-user security boundary. Peer messages are untrusted input and must never be treated as authority. Do not expose the broker beyond loopback, and do not use it for regulated or secret-bearing workflows without an independent review.

---

## What collaboration actually looks like

Imagine you're merging two projects each AI has been working on alone. With this installed, the flow looks like this:

> **You (to Claude):** "Start merging Project A into the monorepo. Ask `codex-backend` anything you need."
>
> **Claude** reads A's auth module, notices it uses `bcrypt@4`, wants to know what B is on. Sends:
> > `to codex-backend:` "A's on bcrypt 4. What version is B on?"
>
> **Codex** receives it on its next agent-peers call—or its exact idle thread is nudged when wakeable mode is enabled. It doesn't auto-reply "got it". It looks at B's `package.json`, sees `bcrypt@5`, and notices B bakes `tenant_id` into JWTs. It sends back:
> > `to claude-frontend:` "B is on bcrypt 5, and we bake `tenant_id` into the JWT — if the merged project drops that claim, multi-tenancy in B breaks. Want me to extract the claims schema to a shared module?"
>
> **Claude** now has a real answer + a surfaced risk + a concrete next step. Replies:
> > `to codex-backend:` "Yes please. Use `shared/auth/claims.ts`. I'll rewire A once you push."

Brief. Substantive. Initiative on both sides. No spam. That's the whole pitch.

---

## What you get

| | |
|---|---|
| 🧠 → 🧠 **Claude ↔ Claude** | Claude's native channel provides a best-effort mid-task hint; the mode-0600 durable inbox remains authoritative if the host drops or queues that hint. |
| 🤖 → 🤖 / 🧠 → 🤖 **Claude ↔ Codex** | Current Codex CLI has no model-visible mid-task push channel for MCP servers, so ordinary Codex sessions pick up peer messages on the next agent-peers tool call. Background poll (1s) and a durable on-disk inbox at `~/.agent-peers-codex/<peer-id>.json` (0o600) preserve unacknowledged messages across restarts. Wakeable mode can start a bodyless app-server turn for an idle session; it is not a native MCP notification. |
| 👥 **Colleague behavior protocol** | Shared prompt imported by both servers: don't auto-reply "got it", investigate before answering, push back on disagreement, ping proactively when you find something the other peer cares about, close every loop. |
| 🏷️ **Friendly names** | Random `calm-fox` by default, or `PEER_NAME=frontend-tab` for a stable one. Your terminal tab renames itself so you can tell sessions apart at a glance. Peers can rename themselves mid-session. |
| 🔍 **Scoped discovery** | `list_peers` with scope `machine` / `directory` / `repo`. Agents find relevant peers without a global cloud directory. |
| 🔐 **Per-user auth** | Session token per peer, per-user shared secret, DB + WAL sidecars + secret file all at 0o600 with a fail-closed startup check. On supported POSIX filesystems this is designed to prevent other OS users from reading peer traffic; startup fails closed if ownership or modes drift. |
| 📬 **Durable local delivery** | Messages are persisted before broker acknowledgement. Both adapters retain and re-present them until the model explicitly calls `ack_messages` with the processed IDs. Delivery is at-least-once, so consumers must tolerate duplicates. |
| ♻️ **Reclaim-safe restart** | Relaunch a dead session with the same `PEER_NAME` → its owner-only durable reclaim credential lets the broker recover the retained UUID and clear stale leases. Backlog lands on the new session's first poll. |

---

## Install

**Ownership split (applies to install, update, AND uninstall).** The repo folder, `node_modules`, the broker daemon, and the SQLite DB at `~/.agent-peers.db` are **shared** between any Claude and Codex sessions on this machine. Claude owns all that shared state. Codex owns only its own `~/.codex/config.toml` entry. If you run prompts from both agents concurrently without this split, they'll race on `git clone`, `bun install`, `rm -rf`, and broker kill — real risk of corrupted install.

**Pick your case — exact steps differ:**

| Your setup | What to run | Order |
|---|---|---|
| 🧠 **Claude only** (no Codex) | Claude install prompt | 1 step |
| 🧠 **+** 🤖 **Both Claude and Codex** | Claude install prompt, then Codex wire-only prompt | Claude FIRST (sets up shared repo), then Codex (writes config.toml only) |
| 🤖 **Codex only** (no Claude) | Manual clone, then Codex wire-only prompt | 1. Shell: `git clone https://github.com/Co-Messi/agent-peers-mcp.git ~/agent-peers-mcp && cd ~/agent-peers-mcp && bun install` — 2. Paste the Codex wire-only prompt |

> **Why Claude-first when you have both:** the Codex wire-only prompt refuses to proceed if it can't find the already-cloned repo + deps. It will not `git clone` or `bun install`, because those are Claude's to own.

> **What the Codex wire-only prompt does:** reads `~/Github Repos/agent-peers-mcp` or `~/agent-peers-mcp` to find the existing install, then appends a single `[mcp_servers.agent-peers]` block to `~/.codex/config.toml`. That's the entire write. It does NOT touch the broker, DB, shared secret, or any file outside `~/.codex/config.toml`.

---

<details>
<summary><b>🧠 For Claude Code — primary install</b> (clones repo, installs deps, wires Claude) — <i>click to expand</i></summary>

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

> **Permission warning:** `--dangerously-skip-permissions` gives Claude a large blast radius. Peer payloads remain untrusted even with the framing added here. Prefer a sandboxed/permissioned launcher when your workflow permits it, and require user confirmation for sensitive actions requested only by a peer.

5. Tell me the install is done and I should:
   - `source ~/.zshrc` (or open a new terminal)
   - Launch another tab with `PEER_NAME=my-name agentpeers`
   - Ask the new session to "list all peers on this machine"
   - If I also want Codex wired up, paste the Codex wire-only install prompt from this repo's README into a Codex session.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

<details>
<summary><b>🤖 For Codex — wire-only install</b> (assumes the shared repo is already cloned) — <i>click to expand</i></summary>

Open a Codex session and paste this verbatim:

````
Wire the agent-peers MCP into my Codex config for me.

CRITICAL — this is a WIRE-ONLY install. The shared agent-peers-mcp repo (node_modules, the broker, the DB at ~/.agent-peers.db) is owned by the Claude Code install prompt (or by me if I cloned manually). You must NOT:
  - clone the repo
  - run `bun install`
  - modify any file outside ~/.codex/config.toml
  - kill or start the broker daemon
  - touch ~/.agent-peers.db or ~/.agent-peers-secret

Doing any of those would race against the Claude Code side and can corrupt the shared install. Your only job in this prompt is to write one block into ~/.codex/config.toml. That's it.

Do the following:

1. Locate the existing shared install. Try these paths in order:
     - ~/Github\ Repos/agent-peers-mcp
     - ~/agent-peers-mcp
     - otherwise ask me where I cloned it — do NOT proceed without an absolute path.
   Verify that $AGENT_PEERS_DIR/codex-server.ts exists. If it does not, STOP and tell me the shared install is missing — I need to run the Claude Code install prompt first, or clone the repo manually (the README has the one-liner).
   Remember the verified absolute path as $AGENT_PEERS_DIR.

2. Append this block to ~/.codex/config.toml (create the file if it doesn't exist; SKIP the write entirely if the [mcp_servers.agent-peers] section is already present — do NOT duplicate):
   [mcp_servers.agent-peers]
   command = "bun"
   args = ["$AGENT_PEERS_DIR/codex-server.ts"]
   env = { "AGENT_PEERS_ENABLED" = "1" }
   Substitute $AGENT_PEERS_DIR with the real absolute path before writing.

   CRITICAL — do NOT omit the `env = { "AGENT_PEERS_ENABLED" = "1" }` line. Without it, the Codex-side MCP server starts in no-op mode: zero tools exposed, no broker connection, and Codex will never see peer messages or appear in anyone's peer list. Setting this env flag to "1" is what activates the peer network.

3. Tell me the install is done and I should:
   - Open a new terminal and run `codex` — the MCP will load automatically
   - Optionally set `PEER_NAME=my-name` before launching for a stable name
   - Ask the new session to "list all peers on this machine"

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

---

## Usage

**Shortest possible path to seeing it work:** open two terminals, launch `agentpeers` in one and `codex` in the other, then ask one of them to `"list all peers on this machine"`. You're off.

If you want more than that, here's the full flow:

### Step 1 — Launch

Open a new terminal and run the launcher for your agent:

| Agent | Command |
|---|---|
| **Claude Code** | `agentpeers` |
| **Codex** | `codex` |

That's it — the MCP loads automatically, the broker auto-spawns if it's not already running, and your terminal tab renames itself to `peer:<name>`.

### Step 2 — Name it (optional but useful)

Every session gets a random friendly name at launch (`calm-fox`, `swift-panda`). For a stable one, set `PEER_NAME` **before** launching:

```bash
PEER_NAME=frontend-tab agentpeers   # Claude
PEER_NAME=backend-work codex        # Codex
```

Rules: 1–32 chars, `[a-zA-Z0-9_-]`, unique among live peers. Name collision auto-suffixes (`frontend-tab` → `frontend-tab-2`). Mid-session rename: just say "rename me to architect" — the tab title updates immediately.

### Step 3 — Sanity check

With two sessions running, ask either of them:

> "List all peers on this machine"

You should see the other. Then:

> "Send a message to peer \<name\>: hello"

What happens on the receiving side:

- **Claude** normally gets a best-effort mid-task `<channel source="agent-peers">` hint. `check_messages` remains the authoritative fallback if the host queues or drops it.
- **Codex** has no model-visible mid-task MCP push, so ordinary sessions receive peer messages on their **next agent-peers tool call**. The shared instructions tell Codex to call `check_messages` at the start of every user turn. Wakeable mode uses app-server to start a turn; it does not add native MCP notifications.

### Step 4 — Real use

A few prompts that showcase what this is actually for:

**Hand off a specific task** →
> "Send to backend-work: I'm changing the auth interface in `auth.ts` — here's the new shape: `…`. Can you update the backend to match?"

**Ask a peer to review your work** →
> "Send to code-reviewer: review my last commit and tell me what's wrong. Be blunt."

**Find the right peer first** →
> "List all peers in this repo and tell me what each one is working on" — each peer keeps a 1-2 sentence `summary` up to date.

**Unblock on a cross-project question** →
> "Send to data-pipeline: what schema does `events` use for the `metadata` column — JSON or text? I need to know before I pick a migration strategy."

The colleague protocol handles the rest: the receiving peer investigates before replying, doesn't spam "got it," pushes back if you're proposing something that'll break their work, and pings you back when they have a real answer (or a real blocker).

---

## Shell CLI

Inspect and control the broker from a terminal (no Claude/Codex session needed):

```bash
bun cli.ts status                        # Broker health + full peer list
bun cli.ts peers                         # Peers only
bun cli.ts send frontend-tab "ship it"   # Send a message from the shell
bun cli.ts rename calm-fox docs-writer   # Admin rename (operator action)
bun cli.ts orphaned-messages             # Messages to peers that died
bun cli.ts purge                          # Apply 24h/7d retention now
bun cli.ts kill-broker                   # Stop the broker daemon
```

Run these from inside the cloned `agent-peers-mcp/` directory.

---

## How it works

- **Broker daemon** (`broker.ts`) binds only to `127.0.0.1:7900` with SQLite at `~/.agent-peers.db`. Clients authenticate broker identity with a nonce-bound HMAC before sending the shared credential; a generic service occupying the port is rejected. DB/WAL files and the per-user secret are mode 0600 on POSIX.
- **Each session** spawns an MCP server (`claude-server.ts` or `codex-server.ts`) that registers with the broker and receives a rotating session token.
- **Claude sessions** persist messages under `~/.agent-peers-claude/` before broker acknowledgement. `notifications/claude/channel` is a best-effort live hint; `check_messages` is the authoritative durable fallback. Messages remain until Claude explicitly calls `ack_messages` with the IDs it processed.
- **Codex sessions** have no mid-task MCP push channel ([OpenAI Codex docs list `tools` as the only supported MCP feature](https://github.com/openai/codex/blob/main/docs/config.md) — resources, prompts, and `notifications/message` aren't surfaced). So Codex runs a two-layer delivery pipeline plus a prompt-level nudge:
  1. **Background poll (1s)** writes each new leased message to a durable on-disk inbox at `~/.agent-peers-codex/<peer-id>.json` (0o600 file, 0o700 dir, fail-closed perm check on read). Crash/restart safe.
  2. **Authoritative `[PEER INBOX]` block** is prepended to the NEXT agent-peers tool response. This is the **only** delivery path the Codex model sees. Full body, reply hints, sender metadata, per-message ids.
  3. **Prompt-level nudge:** the shared colleague instructions tell Codex to call `check_messages` at the start of every user turn. This bounds delivery latency to one user turn — the pragmatic answer to "Codex CLI doesn't support MCP push."
  4. **Signal-only `notifications/message` preview** also fires per poll tick — but current Codex CLI silently drops log notifications, so this is dormant future-compatible plumbing. When Codex adds MCP log surfacing, the preview will light up automatically.
- **Explicit acknowledgement.** Returning an MCP response—or receiving the next tool call—does not prove that the model processed the inbox. Both adapters retain messages on disk and re-present them until the model calls `ack_messages(message_ids=[...])`. Dropped responses and restarts therefore cause safe re-delivery instead of silent loss.
- **Shared colleague protocol.** Both servers import the same `COLLEAGUE_PROTOCOL` string from `shared/colleague-prompt.ts`, so Claude and Codex can't drift on reactive/proactive/maintenance behavior.
- **Sessions recover with stable names and credentials.** Named MCP adapters persist an owner-only reclaim credential in `~/.agent-peers-identities` (directory 0700, files 0600). A matching credential can reclaim a dead PID immediately; otherwise the peer must first pass the 60-second heartbeat timeout. A same-name process without the credential receives a suffixed identity instead of taking over the mailbox. Hidden stale identities remain retained for seven days, and reclaim clears stale leases so backlog is available on the first poll.

Read the full technical spec at [`docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md`](docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md).

---

## Wakeable Codex peers (idle wake, no fork)

Stock Codex CLI can't be woken from idle by an MCP server — it only sees peer messages when it calls an agent-peers tool (see [Known behaviors](#known-behaviors)). **Wakeable mode** closes that gap for Codex **without forking the Codex binary**: launch Codex under a managed Codex app-server, register the live thread, and let a small background daemon nudge that exact thread to call `check_messages` when mail arrives. The nudge is a **bodyless prompt** — the message body is still only ever delivered through the normal `check_messages` tool response.

### Quick start

```bash
# one-time: link the helper onto your PATH
bun bin/codex-peer install      # symlinks ~/.local/bin/codex-peer

# launch a wakeable Codex peer in the current repo (auto-names it <repo>-codex)
codex-peer

# ...or any repo, with an explicit stable name
codex-peer start my-service ~/code/my-service
```

Every launch **auto-starts a single background wake daemon** (idempotent, pidfile-tracked, detached) — you never have to remember to run a watcher, and it comes back on its own on your next launch after a reboot.

### How the wake works

1. `codex-peer` starts `codex app-server --listen ws://127.0.0.1:<port>` plus a visible `codex resume --remote <url> <thread>` TUI bound to one managed thread.
2. The agent-peers MCP child (running under the app-server) registers as a peer and, when mail arrives, writes **bodyless** metadata (sender id/name, timestamp — no body, no lease token) to `~/.agent-peers-codex/<peer>.metadata.json` next to the durable inbox.
3. The wake daemon polls that metadata plus a durable wake registry. For each peer with unread mail whose thread is **loaded and idle**, it sends one bodyless wake prompt into the same app-server thread.
4. Codex calls `check_messages`; the authoritative `[PEER INBOX]` block on that tool response carries the real content. Then it returns to waiting.

It is the **same live instance** — same thread, same rollout, same visible TUI. It is never killed and restarted with fresh context.

### What it costs

- **An idle wakeable peer with no mail spends zero model tokens.** The idle TUI runs no inference; the wake daemon's poll is local-only (metadata files + local WebSocket JSON-RPC to the app-server) and never calls the model. A model turn fires only when there is real unread mail.
- **Each wake re-bills the accumulated thread context** (turns are stateless), so wake cost grows with session age. Re-waking the *same* unread set backs off on an escalating schedule (5m → 30m → 2h) and then stops; a new message is a new signature and always wakes immediately. A deeply-thinking (active) thread is never nudged and never counted toward the cap.

### Operating it

| Command | What it does |
|---|---|
| `codex-peer` | Start a wakeable peer in the cwd (auto-name) |
| `codex-peer start <name> <path>` | Start a wakeable peer with a stable name |
| `codex-peer live` | Show wakeable sessions + unread counts |
| `codex-peer daemon-status` / `daemon-stop` | Inspect / stop the background daemon |
| `codex-peer repair-wake <name>` | Re-attach a live peer whose wake pointer was lost |
| `codex-peer retire <name>` | Remove a stale/confusing peer from discovery |

Full design, security model, and failure-mode notes: [`docs/wakeable-codex.md`](docs/wakeable-codex.md).

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PEERS_PORT` | `7900` | Broker port |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | SQLite path |
| `PEER_NAME` | auto-generated | Human-readable peer name at launch (1-32 chars, `[a-zA-Z0-9_-]`) |
| `OPENAI_API_KEY` | — | API credential used only when auto-summary is explicitly opted in |
| `AGENT_PEERS_AUTO_SUMMARY` | `0` | Set to `1` to send redacted/coarse repository metadata to OpenAI for a one-sentence summary |
| `AGENT_PEERS_DISABLE_TAB_TITLE` | — | Set to `1` to skip terminal tab title writing |
| `AGENT_PEERS_CODEX_STATE_DIR` | `~/.agent-peers-codex` | Codex durable inbox + wake registry/daemon state dir |
| `CODEX_PEER_DAEMON_INTERVAL` | `5` | Background wake daemon poll interval (seconds) |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` | `5242880` | Size at which `wake-daemon.log` is rotated (copy-truncate) |
| `CODEX_PEER_DAEMON_LOG_KEEP` | `3` | Number of rotated wake-daemon logs to keep |

See [docs/wake-daemon.md](docs/wake-daemon.md) for wake-daemon operations: log
format, the wedged-peer (`systemError`) signal, and tuning.

---

## Known behaviors

**Claude sessions only activate peers when you launch via `agentpeers`.**
The `agentpeers` alias sets `AGENT_PEERS_ENABLED=1`. Plain `claude` does not, so the MCP loads in idle/no-op mode — no peer registration, no tab title change, no broker connection. This is intentional: the MCP is registered globally in `~/.claude.json`, so every `claude` session spawns it, and we don't want the peer network showing up in unrelated sessions.

**Codex always has peers active** (as long as you included `env = { "AGENT_PEERS_ENABLED" = "1" }` in your `config.toml` entry). If you want a Codex session without peers, remove or comment out that `env` line temporarily.

**Idle sessions don't auto-reply — they see messages on their next turn.**
Both Claude and Codex process peer messages **during turns**, not while idle at the prompt. If you send a message to a peer who is sitting at an empty prompt, they won't magically reply — their session will surface the message on its next user turn (when you type something, or ask them to "check messages"). This is a hard constraint of both Claude Code and Codex CLI, not a bug in this server — neither client exposes a way for an MCP server to trigger a turn from outside.

What we do to make this as painless as possible: **both agents are instructed to call `check_messages` at the start of every user turn.** Claude additionally has the live `<channel source="agent-peers" ...>` push path for mid-turn arrivals. So the worst-case lag is "one of your own user turns" — type "hi" or "what's new" to a quiet peer and any pending messages surface in their first response.

**`check_messages` works on BOTH agents and returns the same `[PEER INBOX]` framing.**
On both adapters, it reads the durable mode-0600 inbox without consuming it. Messages remain eligible for re-presentation until `ack_messages` explicitly confirms their IDs. Just type "check messages" whenever you want to see what peers have sent.

**On Codex, the `notifications/message` preview is dormant.**
Current Codex CLI does not surface `notifications/message` to the model. We still emit a bodyless preview as dormant future-compatible plumbing. Today it is a no-op; wakeable mode instead starts a bodyless app-server turn that calls the ordinary MCP tool path.

**Tab title ("peer:calm-fox") is re-asserted every 1 second via OSC 0/1/2.**
Most terminals (iTerm2, Terminal.app, Ghostty, Warp) track the running foreground process and periodically overwrite the tab title with the binary name ("node" / "bun"). A one-shot OSC write at startup therefore decays. The MCP server runs a lightweight keepalive that writes OSC 0 (window+icon title), OSC 1 (icon/tab title — what iTerm2 uses for tabs), and OSC 2 (window title) every 1s so `peer:<name>` stays visible. If your terminal is configured with a hardcoded title source (e.g. iTerm2 "Profile → General → Title" overriding application writes), we can't win — set `AGENT_PEERS_DISABLE_TAB_TITLE=1` to opt out of the keepalive entirely.

**Closed tabs disappear from discovery within ~60 seconds, but the backlog isn't stranded.**
When you close a tab, the shell kills the session without graceful cleanup. The peer row stays in the broker until its heartbeat goes stale (~60s). `list_peers` filters stale peers out of results immediately. Stale identity rows are retained for seven days. Restarting a named MCP adapter presents its persisted reclaim credential and recovers the UUID. The broker clears stale leases, and the durable inbox replays entries that were presented but never explicitly acknowledged.

---

## Troubleshooting

**"No other peers found"**
Make sure at least two sessions are running with the MCP loaded. Run `bun cli.ts status` from a third shell to confirm the broker sees them.

**Broker port 7900 already in use**
Kill any old broker: `bun cli.ts kill-broker`. If another process owns the port, set `AGENT_PEERS_PORT=7901` in your env.

**Codex doesn't see the inbox**
Ask it to call `list_peers` or `check_messages` — messages surface on any agent-peers tool response, not just specific ones. If you still don't see the `[PEER INBOX]` block, your Codex version may not render tool responses verbatim; file an issue with your Codex version.

**Upgraded from an older install and existing peers aren't working**
The broker assigns legacy rows temporary session tokens, marks them stale, and preserves their UUIDs and mailboxes. A legacy row permits one credential bootstrap by the same `PEER_NAME`; that registration writes a new owner-only reclaim credential for subsequent restarts.

**Running alongside upstream `claude-peers-mcp`**
They coexist cleanly on different ports (7900 vs 7899) and different MCP names (`agent-peers` vs `claude-peers`). You can use both simultaneously; they don't share state.

---

## Architecture

```
agent-peers-mcp/
├── broker.ts                                  # HTTP+SQLite daemon (7900, 0o600 DB, shared-secret auth)
├── claude-server.ts                           # MCP server — claude/channel push delivery
├── codex-server.ts                            # MCP server — durable queue + signal-only preview + [PEER INBOX]
├── cli.ts                                     # Admin / inspection CLI (+ live / repair-wake / retire)
├── bin/codex-peer                             # Wakeable Codex launcher + background wake daemon manager
├── wakeable-codex.ts                          # Entry: launch app-server-backed wakeable Codex TUI
├── wake-daemon.ts                             # Entry: one wake pass (the daemon loop calls this)
├── shared/
│   ├── types.ts                               # API types
│   ├── broker-client.ts                       # Typed HTTP client
│   ├── ensure-broker.ts                       # Auto-spawn helper
│   ├── peer-context.ts                        # git root / tty / pid
│   ├── tab-title.ts                           # OSC terminal title
│   ├── summarize.ts                           # gpt-5.4-nano auto-summary
│   ├── piggyback.ts                           # [PEER INBOX] block + signal-only preview formatters
│   ├── codex-inbox.ts                         # Durable on-disk inbox + bodyless metadata (~/.agent-peers-codex, 0o600)
│   ├── app-server-client.ts                   # Minimal Codex app-server JSON-RPC client (bounded timeouts)
│   ├── wakeable-launcher.ts                   # Starts app-server + managed thread + visible TUI
│   ├── wake-registry.ts                       # Durable peer_id -> app-server/thread registry (+ GC)
│   ├── wake-launch-claims.ts                  # Launcher <-> MCP-child handshake (+ ambiguity-safe matching)
│   ├── wake-daemon.ts                         # Wake engine: idle-only nudge, backoff + attempt cap + GC
│   ├── wait-for-peer-messages.ts              # Bounded wait helper for wait_for_peer_messages
│   ├── colleague-prompt.ts                    # COLLEAGUE_PROTOCOL string shared by both servers
│   ├── shared-secret.ts                       # Per-user broker auth secret provisioning
│   └── names.ts                               # adjective-noun generator
├── tests/                                     # 200+ tests — broker, delivery, persistence, security, wake, and app-server flows
├── docs/
│   └── wakeable-codex.md                       # Wakeable Codex design, security model, failure modes
├── docs/superpowers/
│   ├── specs/2026-04-13-agent-peers-mcp-design.md      # Full spec (post 7 review rounds + PR #2 amendments)
│   └── plans/2026-04-13-agent-peers-mcp-implementation.md
└── docs/plans/
    ├── 2026-04-15-codex-conversation-design.md         # Historical: durable-queue design rationale
    └── 2026-04-15-codex-conversation-plan.md           # Historical: implementation plan
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

**Within a single session** — delivery is at-least-once. Message IDs support deterministic dedupe, but callers must tolerate duplicates around crashes, lease expiry, and acknowledgement retries.

**Across a process restart** — stale identities remain reclaimable for seven days; durable inbox files and broker leases preserve messages when the same stable `PEER_NAME` is reclaimed. Random names do not provide a stable restart identity. Replies must be idempotent.

**Retention** — acknowledged rows are purged after 24 hours and undeliverable orphan rows after 7 days. Run `bun cli.ts purge` to apply retention immediately. Unacknowledged live mailboxes are capped at 1,000 messages per recipient.

**Resource limits** — HTTP bodies are capped at 64 KiB, message bodies at 16 KiB, poll/ack batches and active/discovered peers at 100 (so no accepted live peer is hidden on an unreachable second page), retained restart identities at 1,024, unread durable inbox state at 2 MiB/1,000 messages, and retained broker messages at 10,000. Fresh registration events survive unregister within the one-minute rate window; individual senders and aggregate sends also have per-minute limits.

**Peer-to-peer security** — every peer gets a rotating session token and named adapters keep a separate durable reclaim credential. Wrong or expired tokens return explicit failures, and name knowledge alone cannot take over a dead peer's mailbox. Broker identity is HMAC-authenticated, HTTP bodies and fields are bounded, and peer text is wrapped as untrusted JSON data. This reduces risk but does not make same-user peers mutually trusted or sandbox their other tools.

---

## Update (pull latest version)

**Same ownership split as Install.** Whoever owns the shared repo is responsible for pulling new code. Do NOT run the update prompt from both agents concurrently — they'll race on `git pull`, `bun install`, and broker kill.

**Pick your case:**

| Your setup | What to run | Result |
|---|---|---|
| 🧠 **Claude only** | Claude update prompt | Pulls repo, reinstalls deps, runs tests, tells you to restart any running `agentpeers` sessions |
| 🧠 **+** 🤖 **Both** | Claude update prompt **only** (Claude owns the shared repo) | Pulls repo, reinstalls deps, runs tests, tells you to restart BOTH `agentpeers` AND `codex` sessions |
| 🤖 **Codex only** | Codex-only update prompt | Pulls repo, reinstalls deps, runs tests, tells you to restart Codex sessions |

> **If you run the Codex-only update prompt with Claude ALSO wired up**, it will detect the conflict (checks `~/.claude.json` for an `agent-peers` entry) and stop with a message telling you to run the Claude update prompt instead. This is a safety rail — do not override it.

> **Why is there no "Codex update after Claude update" step?** Codex doesn't own the repo in the mixed-agents case. Once Claude has pulled new code, Codex just needs to be relaunched so the new `codex-server.ts` loads into the new MCP process. That's "close the terminal and open a new one," not a prompt.

---

<details>
<summary><b>🧠 For Claude Code — update prompt</b> (the ONLY update prompt if you have both agents installed) — <i>click to expand</i></summary>

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

9. Tell me to close and relaunch any running `agentpeers` AND `codex` sessions so the new MCP server code is loaded. Both agents share this repo, so both sets of sessions need to restart. Existing sessions keep running the OLD code until they restart.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

<details>
<summary><b>🤖 For Codex — update prompt</b> (Codex-only installs only — DO NOT run this if Claude Code is also wired up) — <i>click to expand</i></summary>

Open a Codex session and paste this verbatim. **Skip this entire section** if you have Claude Code installed — the Claude update prompt above already handles the shared repo for both agents.

````
Update agent-peers-mcp to the latest version on my machine.

CRITICAL — before starting, verify I am the sole installer of this MCP:

1. Check ~/.claude.json — if it has an entry with name "agent-peers" OR an mcpServers["agent-peers"] key, Claude Code is ALSO wired to this shared repo. STOP immediately and tell me: "Claude Code is also using this install. The shared repo update is Claude's job — paste the Claude Code update prompt from the README into a Claude session instead. Once Claude has updated, come back here and I'll just tell you to restart your Codex sessions." Do NOT proceed.

2. If ~/.claude.json has NO agent-peers entry (or the file doesn't exist), I am the sole installer. Continue.

Step 2 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to update before proceeding. Do NOT modify anything until I confirm.

Once I confirm the path, do all of the following in order:

1. cd into the confirmed install directory.

2. Stop any running broker daemon so the upgrade can replace files cleanly:
   - Run `lsof -t -i:7900` to find broker PIDs.
   - Kill each with `kill -TERM <pid>` (SIGKILL after 2s if needed).
   - Also try `bun cli.ts kill-broker` as a fallback.

3. Record the current commit SHA for rollback reference:
   `git rev-parse --short HEAD` — save the value so you can tell me later.

4. DIRTY WORKTREE CHECK — before any destructive git action:
   Run `git status --porcelain`. If it produces ANY output (modified, added, or untracked files), STOP. Show me the output and ask whether I want to: (a) stash my changes and proceed, (b) abort the update, or (c) blow the changes away with a hard reset. Do NOT proceed until I answer.
   If `git status --porcelain` is empty, continue.

5. Pull the latest code with a fast-forward pull:
   `git fetch origin main && git pull --ff-only origin main`
   If that fails, fall back to `git reset --hard origin/main` — but only after explicit confirmation.

6. Refresh dependencies: `bun install`

7. Run the test suite as a sanity check: `bun test`
   If any test fails, STOP and show me the failure output — do NOT tell me the update is complete.

8. Print a summary: old commit SHA, new commit SHA, the short-log between them (`git log --oneline <old>..HEAD`), and what tests passed.

9. Tell me to close and relaunch any running Codex sessions so the new MCP server code is loaded.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

---

## Uninstall

**Same ownership split, but reversed order vs install.** Why? When you're tearing down, you want Codex to STOP trying to launch the MCP binary *before* Claude deletes that binary. Otherwise every new `codex` session you open after uninstall will error on startup looking for a file that's gone.

**Pick your case:**

| Your setup | What to run | Order + why |
|---|---|---|
| 🧠 **Claude only** | Claude uninstall prompt | 1 step — it removes Claude's MCP registration, the `agentpeers` alias, the shared repo, the broker, and all `~/.agent-peers*` state files. |
| 🧠 **+** 🤖 **Both** | Codex uninstall prompt **first**, then Claude uninstall prompt | **Codex FIRST** so Codex stops trying to spawn `codex-server.ts` on every new session. Codex's uninstall auto-detects the two-agent case and does a **config-only** teardown (removes only the `~/.codex/config.toml` block, leaves the shared repo alone). Then Claude's uninstall tears down the shared repo, broker, DB, alias, secret file, and Codex's durable inbox directory. |
| 🤖 **Codex only** | Codex uninstall prompt | 1 step — Codex's uninstall auto-detects the solo case (no `agent-peers` entry in `~/.claude.json`) and does a **full** teardown: removes its `config.toml` block AND the shared repo, broker, DB, secret, and inbox directory. |

> **Why the Codex prompt auto-branches instead of being two different prompts:** one prompt handles all three cases reliably by reading `~/.claude.json` up-front to figure out whether shared state is Claude's to clean up or Codex's. If it finds Claude wired, it does "Case A" (config-only). If it doesn't, "Case B" (full teardown). This keeps the README short and prevents the user picking the wrong prompt.

> **Why Claude uninstall checks Codex's config.toml:** it looks for a lingering `[mcp_servers.agent-peers]` entry and warns you before deleting the shared repo. It does NOT auto-edit `~/.codex/config.toml` — that's Codex's prompt's job. The warning is there so you don't end up with a dangling Codex wiring pointing at a deleted binary.

---

<details>
<summary><b>🤖 For Codex — uninstall prompt</b> (run this FIRST if you have both agents installed) — <i>click to expand</i></summary>

Open a Codex session and paste this verbatim:

````
Remove the agent-peers MCP wiring from my Codex config. I may or may not still want Claude Code to keep using the shared repo — detect which and act accordingly.

Do NOT wipe anything until you've done this detection step:

1. Check ~/.claude.json for an "agent-peers" MCP entry (either a top-level `agent-peers` block or an mcpServers["agent-peers"] key). Tell me explicitly which case we're in:
   - CASE A — Claude Code is also wired up: I'm doing a config-only teardown on the Codex side. The shared repo, node_modules, broker, and DB are staying — they belong to Claude Code. My only job is to remove my Codex wiring.
   - CASE B — Claude Code is NOT wired up (or ~/.claude.json doesn't exist / has no agent-peers entry): I'm the sole installer, so I will do a FULL teardown — config, shared repo, and broker state.

Ask me to confirm which case applies before touching anything. If I confirm CASE A, proceed with steps 2-3 below. If CASE B, proceed with steps 2-6.

STEP 2 (both cases) — Remove the [mcp_servers.agent-peers] block from ~/.codex/config.toml. Keep every other mcp_servers entry and every other section intact. If you are not 100% certain you can surgically edit TOML, FIRST show me the exact block you intend to remove and ask me to confirm before writing.

STEP 3 (CASE A only) — Summarize: tell me "Codex wiring removed. Shared repo at <path> and DB at ~/.agent-peers* are Claude Code's to own — if you want those gone too, run the Claude Code uninstall prompt from the README next." Stop here.

STEP 4 (CASE B only) — Stop the broker:
   - Run `lsof -t -i:7900` to find broker PIDs.
   - Kill each one with `kill -TERM <pid>` (SIGKILL after 2s if needed).
   - Also run `bun cli.ts kill-broker` from inside the repo directory if it still exists.

STEP 5 (CASE B only) — Find and delete the shared repo. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp. If you find more than one or are uncertain, LIST candidates and ASK me before deleting. Remove recursively.

STEP 6 (CASE B only) — Delete all broker state files in my home directory:
   rm -f ~/.agent-peers.db ~/.agent-peers.db-shm ~/.agent-peers.db-wal ~/.agent-peers-secret
   rm -rf ~/.agent-peers-codex
   Run `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` to confirm nothing is left.

STEP 7 (CASE B only) — Summarize: list every path/resource you removed and paste the `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` output so I can verify.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

<details>
<summary><b>🧠 For Claude Code — uninstall prompt</b> (tears down the shared repo + broker + DB) — <i>click to expand</i></summary>

Open a Claude Code session and paste this verbatim. **If you also had Codex wired up**, run the Codex uninstall prompt above first so Codex stops trying to launch the server.

````
Completely uninstall agent-peers-mcp for me — I want every trace gone from the Claude side + the shared state.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to remove before proceeding. Do NOT delete anything until I confirm.

Step 2 — Codex coexistence check. Read ~/.codex/config.toml. If it still contains a [mcp_servers.agent-peers] block, WARN me: "Codex is still wired to this MCP — after I remove the shared repo, Codex will fail to start any new session until you also remove its [mcp_servers.agent-peers] block (run the Codex uninstall prompt). Want me to continue anyway?" Do not auto-edit Codex's config — that's its own prompt's job.

Once I confirm the path (and any warnings), do a FULL wipe — do not ask per-item confirmations; just do everything:

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

5. Delete ALL broker + Codex-inbox state files under my home directory:
   - ~/.agent-peers.db
   - ~/.agent-peers.db-shm
   - ~/.agent-peers.db-wal
   - ~/.agent-peers-secret
   - ~/.agent-peers-codex/ (directory, recursive — holds Codex's durable inbox files)
   Use `rm -f ~/.agent-peers.db ~/.agent-peers.db-shm ~/.agent-peers.db-wal ~/.agent-peers-secret` and `rm -rf ~/.agent-peers-codex` so missing paths don't error. Also run `ls -la ~/.agent-peers* 2>/dev/null` afterwards to confirm nothing is left.

6. Tell me to run `source ~/.zshrc` (or open a new terminal) so the alias change takes effect.

7. Give me a final summary listing every path and resource you removed, plus anything you couldn't remove and why. Also paste the output of `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` so I can see it's fully gone. If I had Codex wired up and I haven't run the Codex uninstall prompt yet, remind me to do that now.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

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
