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

> Hardened, security-reviewed successor to [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with Codex CLI support + a full colleague-behavior protocol added.

---

## What collaboration actually looks like

Imagine you're merging two projects each AI has been working on alone. With this installed, the flow looks like this:

> **You (to Claude):** "Start merging Project A into the monorepo. Ask `codex-backend` anything you need."
>
> **Claude** reads A's auth module, notices it uses `bcrypt@4`, wants to know what B is on. Sends:
> > `to codex-backend:` "A's on bcrypt 4. What version is B on?"
>
> **Codex** receives it mid-task. Doesn't auto-reply "got it" (it's trained not to). Goes quiet, looks at B's `package.json`. Sees `bcrypt@5`. *Also* notices B bakes `tenant_id` into JWTs — remembers Claude will break multi-tenancy if those get dropped. Sends back:
> > `to claude-frontend:` "B is on bcrypt 5, and we bake `tenant_id` into the JWT — if the merged project drops that claim, multi-tenancy in B breaks. Want me to extract the claims schema to a shared module?"
>
> **Claude** now has a real answer + a surfaced risk + a concrete next step. Replies:
> > `to codex-backend:` "Yes please. Use `shared/auth/claims.ts`. I'll rewire A once you push."

Brief. Substantive. Initiative on both sides. No spam. That's the whole pitch.

---

## What you get

| | |
|---|---|
| 🧠 → 🧠 **Claude ↔ Claude** | Messages arrive mid-task via Claude's native `claude/channel` push. Instant. |
| 🤖 → 🤖 / 🧠 → 🤖 **Claude ↔ Codex** | Codex polls the broker every 1s and persists unread messages to a durable local inbox. Full content surfaces as a `[PEER INBOX]` block in the next agent-peers tool response. A signal-only MCP log preview also fires mid-task on Codex builds that surface them. |
| 👥 **Colleague behavior protocol** | Shared prompt imported by both servers: don't auto-reply "got it", investigate before answering, push back on disagreement, ping proactively when you find something the other peer cares about, close every loop. |
| 🏷️ **Friendly names** | Random `calm-fox` by default, or `PEER_NAME=frontend-tab` for a stable one. Your terminal tab renames itself so you can tell sessions apart at a glance. Peers can rename themselves mid-session. |
| 🔍 **Scoped discovery** | `list_peers` with scope `machine` / `directory` / `repo`. Agents find relevant peers without a global cloud directory. |
| 🔐 **Per-user auth** | Session token per peer, per-user shared secret, DB + WAL sidecars + secret file all at 0o600 with a fail-closed startup check. Another local user can't eavesdrop on your peer traffic. |
| 📬 **At-least-once delivery** | 30s lease → confirm-on-next-call ack. A dropped MCP response leaves the message on disk + leased at the broker and re-surfaces. Never silently lost. Unreachable recipient → message becomes an orphan, visible via `cli.ts orphaned-messages`. |
| ♻️ **Reclaim-safe restart** | Kill a session and relaunch with the same `PEER_NAME` within 60s → broker reclaims the UUID *and* clears stale leases. Backlog lands on the new session's first poll. |

---

## Install

**Important — ownership split.** The repo folder, `node_modules`, the broker, and the SQLite DB at `~/.agent-peers.db` are **shared** between any Claude and Codex sessions on this machine. To avoid races (both agents cloning at once, both running `bun install`, both trying to own the broker) responsibilities are split:

- **Claude Code prompt** = the **primary** install. Owns all shared state: clones the repo, runs `bun install`, registers Claude's MCP with `claude mcp add`, writes the `agentpeers` alias.
- **Codex prompt** = a **wire-only** install. It only writes the `[mcp_servers.agent-peers]` block to `~/.codex/config.toml`. It does **not** clone, it does **not** `bun install`, and it does **not** touch the broker or DB — those belong to Claude.

Pick your path:

- **Both Claude and Codex active?** Run the Claude prompt FIRST (it sets up the shared repo + deps). Then run the Codex prompt — it auto-detects the install path Claude chose.
- **Claude only?** Run the Claude prompt. Done.
- **Codex only, no Claude?** You need to set up the shared repo manually first. One-liner:
  ```bash
  git clone https://github.com/Co-Messi/agent-peers-mcp.git ~/agent-peers-mcp && cd ~/agent-peers-mcp && bun install
  ```
  Then run the Codex prompt below — it'll find `~/agent-peers-mcp` and wire your config.toml.

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

- **Claude** sees it **instantly**, mid-task, via a `<channel source="agent-peers">` push.
- **Codex** persists it to its local inbox within 1 second and fires a `notifications/message` preview. The full `[PEER INBOX]` block lands on Codex's next agent-peers tool response (call `check_messages` if you want it surfaced right now).

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
bun cli.ts kill-broker                   # Stop the broker daemon
```

Run these from inside the cloned `agent-peers-mcp/` directory.

---

## How it works

- **Broker daemon** (`broker.ts`) runs on `localhost:7900` with SQLite at `~/.agent-peers.db`. Auto-launches on first session. DB + WAL sidecars are 0o600, per-user shared secret at `~/.agent-peers-secret` (also 0o600) authenticates peer HTTP calls.
- **Each session** spawns an MCP server (`claude-server.ts` or `codex-server.ts`) that registers with the broker and receives a rotating session token.
- **Claude sessions** poll the broker every 1s and push inbound messages via `notifications/claude/channel` → Claude sees the message mid-task.
- **Codex sessions** have no native push channel, so they run a two-layer delivery pipeline:
  1. **Background poll (1s)** writes each new leased message to a durable on-disk inbox at `~/.agent-peers-codex/<peer-id>.json` (0o600 file, 0o700 dir, fail-closed perm check on read). Crash/restart safe.
  2. **Best-effort signal-only preview** fires an MCP `notifications/message` log event on each tick — carries sender name + peer_type + a pointer to where the authoritative delivery lands. No message body, no reply instructions (prevents the double-reply risk if both channels render to the model).
  3. **Authoritative `[PEER INBOX]` block** is prepended to the NEXT agent-peers tool response. This is the single source of truth for the model — full body, reply hints, sender metadata, and per-message ids.
- **Confirm-on-next-call dedupe.** Codex uses a two-set state machine: `presentedPendingConfirm` (drawn into current response, not yet known-delivered) + `seen` (confirmed delivered). Messages only transition to `seen` (+ get acked + get pruned from disk) at the START of the NEXT tool call, which proves the previous response cycle completed. Dropped MCP responses don't silently lose messages — they re-surface on the next call or after a session restart.
- **Shared colleague protocol.** Both servers import the same `COLLEAGUE_PROTOCOL` string from `shared/colleague-prompt.ts`, so Claude and Codex can't drift on reactive/proactive/maintenance behavior.
- **Sessions gracefully restart.** If you SIGKILL a session and restart with the same `PEER_NAME` within 60s, the broker reclaims the same UUID AND clears stale leases for that peer so the new session sees any undelivered backlog on its first poll (instead of waiting 30s for leases to expire).

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
There is still no native Codex push channel, so authoritative delivery happens on the next response from an agent-peers tool (`list_peers`, `send_message`, `set_summary`, `check_messages`, or `rename_peer`). Background polling (1s) keeps the local inbox at `~/.agent-peers-codex/<peer-id>.json` fresh, and a signal-only `notifications/message` preview fires when new messages land — "heads up, message from X waiting." Ask Codex "check messages" when you want the inbox surfaced immediately.

**The live-preview experience varies by Codex CLI build.**
Whether the `notifications/message` preview shows up in Codex's live transcript (and whether the model can see it) depends on your Codex CLI version — MCP log notifications are part of the standard spec but client surfacing is still evolving. If your build doesn't plumb them through, no harm: the authoritative `[PEER INBOX]` delivery path still works on the next tool call and carries full content + reply instructions.

**Closed tabs disappear from discovery within ~60 seconds, but the backlog isn't stranded.**
When you close a tab, the shell kills the session without graceful cleanup. The peer row stays in the broker until its heartbeat goes stale (~60s). `list_peers` filters stale peers out of results immediately — you won't see ghost peers there even in that window. If you restart with the same `PEER_NAME` within 60-90s, the broker reclaims the same UUID AND clears any stale leases for that peer, so the new session picks up undelivered backlog on its first poll instead of waiting up to 30s for leases to expire. Codex additionally persists its durable inbox on disk, so messages sitting on a reclaimed session are replayed even if they were drawn but not yet confirmed delivered.

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
├── broker.ts                                  # HTTP+SQLite daemon (7900, 0o600 DB, shared-secret auth)
├── claude-server.ts                           # MCP server — claude/channel push delivery
├── codex-server.ts                            # MCP server — durable queue + signal-only preview + [PEER INBOX]
├── cli.ts                                     # Admin / inspection CLI
├── shared/
│   ├── types.ts                               # API types
│   ├── broker-client.ts                       # Typed HTTP client
│   ├── ensure-broker.ts                       # Auto-spawn helper
│   ├── peer-context.ts                        # git root / tty / pid
│   ├── tab-title.ts                           # OSC terminal title
│   ├── summarize.ts                           # gpt-5.4-nano auto-summary
│   ├── piggyback.ts                           # [PEER INBOX] block + signal-only preview formatters
│   ├── codex-inbox.ts                         # Durable on-disk inbox (~/.agent-peers-codex, 0o600)
│   ├── colleague-prompt.ts                    # COLLEAGUE_PROTOCOL string shared by both servers
│   ├── shared-secret.ts                       # Per-user broker auth secret provisioning
│   └── names.ts                               # adjective-noun generator
├── tests/                                     # 84 tests — broker, migration, piggyback, client, names, codex-inbox, shared-secret
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

**Within a single session** — deterministic dedupe by `message_id` via in-memory seen-set. Same message is never delivered twice while your process is alive.

**Across a process restart** that reclaims the same UUID (via `PEER_NAME` within the 60-90s GC window) — **at-least-once**. A message polled but not acked before a crash may be re-delivered once. Replies should be idempotent.

**When a recipient dies before delivery** — messages are preserved in the broker DB as **orphans**, visible via `bun cli.ts orphaned-messages`. Never silently lost.

**Peer-to-peer security** — every peer gets a session token on register. Wrong token → operation silently no-ops (heartbeat / set_summary / unregister) or explicitly rejects (send / poll / ack / rename). You cannot impersonate, drain, or rename another peer via the MCP.

---

## Update (pull latest version)

**Ownership split applies here too.** The shared repo (and `bun install` + tests + broker-restart) is Claude's to maintain. Running the update from both agents concurrently would race on `git pull`, corrupt `node_modules`, and kill each other's broker mid-upgrade. So:

- **Have Claude Code installed?** Run the **Claude update prompt** below — it handles the shared repo pull + deps + test run + tells you to restart BOTH Claude and Codex sessions when it's done. You do not need to run anything on the Codex side beyond closing and reopening your Codex terminals after Claude finishes.
- **Have Codex only, no Claude Code?** Use the **Codex-only update prompt** further below — it's the same as the Claude one but assumes Codex is the sole installer, so it's safe for it to own the shared repo.

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

**Ownership split — same rule as Install and Update.** The shared repo, broker, and DB are Claude's to own. Codex only owns its own `~/.codex/config.toml` entry.

- **Both agents installed?** Run BOTH prompts below, in order: Codex-first (pulls only the `config.toml` block so Codex stops trying to launch a server during the next step), then Claude (tears down the shared repo, broker, DB, alias). If you run only one, the other agent will keep trying to launch a now-broken server every time it starts.
- **Claude only?** Run the Claude prompt. Done.
- **Codex only?** Run the Codex prompt — it detects you're the sole installer and will do a FULL teardown (including shared repo + DB).

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
