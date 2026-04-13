# agent-peers-mcp — Design Spec

**Date:** 2026-04-13
**Status:** Phase 1 MVP design, approved
**Goal:** Unified peer-discovery + messaging MCP supporting Claude Code AND Codex CLI sessions on the same broker, fully isolated from the existing stable `claude-peers-mcp` install.

---

## 1. Motivation

The user runs many parallel Claude Code sessions and now also Codex CLI sessions. The existing `claude-peers-mcp` (cloned at `~/Github Repos/claude-peers-mcp`, registered as MCP `claude-peers`, broker on `:7899`) lets Claude sessions talk to each other, but Codex is excluded.

Goal: one project where Claude↔Claude, Codex↔Codex, and Claude↔Codex all work via a single broker.

**Hard constraint:** the existing `claude-peers-mcp` must remain untouched and stable. The new project runs in parallel on a different port and a different DB file. Breaking the new system cannot affect the old.

---

## 2. Scope

### Phase 1 (this spec) — post-adversarial-review revision
- Broker on isolated port + DB
- `claude-server.ts` reusing proven push-via-channel pattern
- `codex-server.ts` with **piggyback delivery on every tool call** (every tool handler polls broker first; pending messages prepended to the response)
- **Explicit ack/lease protocol** (broker leases messages for 30s; client acks only after transport-level send confirms; expired leases re-deliver)
- **Broker-owned timer GC** (stale peers removed every 30s; liveness check on every `/send-message`)
- **Self-rename only** in the `rename_peer` tool; admin rename lives only in `cli.ts` (local operator action)
- **Self-contained piggyback blocks** — each `[PEER INBOX]` injection includes the reply hint inline so Codex does not depend on the MCP `instructions` field or any global config mutation for basic message-handling behavior
- `peer_type` column on broker so any client can see who's a Claude vs Codex agent
- `name` column (immutable `id` + mutable `name`) — self-rename tool, auto-generated names, terminal tab title
- `cli.ts` for inspection + admin rename
- `README.md` with copy-paste install commands

### Phase 2 (deferred, separate spec when needed)
- Runtime broker-crash recovery (auto-reconnect on poll failure mid-session)
- `install.ts` script to print + clipboard install commands
- `identify_peer` ping tool (terminal bell + flash message for visual disambiguation)
- Message TTL / retention policy
- Optional cross-machine support, auth, encryption

### Why the scope changed after the first adversarial review

Codex's initial plan review flagged four high-severity issues that would have caused real correctness bugs if deferred. All four are promoted into Phase 1 as a result:
1. Mark-delivered-on-poll = silent data loss → replaced with explicit lease + ack protocol
2. Reactive-only peer GC = stale routing targets → replaced with broker-owned timer GC + send-time liveness check
3. Admin rename open to all peers = impersonation risk → restricted to self-rename in Phase 1
4. Codex correctness relying on `instructions` field + global AGENTS.md fallback = prompt-obedience failure mode + isolation violation → replaced with always-on piggyback delivery and self-contained inline reply hints

The Phase 1 / Phase 2 split still follows the user's preference for iterative shipping, but the dividing line is now "correctness primitives in Phase 1; convenience features in Phase 2".

---

## 3. Isolation from existing stable system

| Aspect | Existing `claude-peers-mcp` (untouched) | New `agent-peers-mcp` |
|---|---|---|
| Project location | `/Users/siewbrayden/Github Repos/claude-peers-mcp` | `/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp` |
| Broker port | 7899 | **7900** |
| SQLite DB path | `~/.claude-peers.db` | `~/.agent-peers.db` |
| MCP registration name (Claude) | `claude-peers` | `agent-peers` |
| MCP registration name (Codex) | (n/a) | `agent-peers` |
| Launcher alias (zsh) | `claudedpeers` | `agentpeers` |
| Server entry points | single `server.ts` | `claude-server.ts` + `codex-server.ts` |
| Broker schema | (no peer_type column) | adds `peer_type` |

Both systems can be active simultaneously. The user can keep using `claudedpeers` for stable peer messaging while testing `agentpeers` separately.

---

## 4. Architecture

```
                       ┌────────────────────────────────┐
                       │  agent-peers broker            │
                       │  HTTP + SQLite                 │
                       │  127.0.0.1:7900                │
                       │  ~/.agent-peers.db             │
                       └──┬──────────┬───────────┬──────┘
                          │          │           │
                  claude-server  claude-server  codex-server
                  (push channel) (push channel) (check_messages)
                          │          │           │
                       Claude A   Claude B   Codex A
                       (claudedpeers-style alias 'agentpeers')
```

- One broker daemon, auto-spawned by the first MCP server that starts up
- Two MCP server binaries with different transport strategies, sharing core logic
- Both binaries register peers on the same broker → unified message bus

### 4.1 File layout

```
agent-peers-mcp/
├── broker.ts                  # HTTP daemon + SQLite
├── claude-server.ts           # MCP server with claude/channel push
├── codex-server.ts            # MCP server with check_messages tool
├── cli.ts                     # Status/peers/send/kill-broker
├── shared/
│   ├── types.ts               # PeerType, Peer, Message, request/response
│   ├── broker-client.ts       # HTTP wrapper used by both servers + cli
│   ├── ensure-broker.ts       # Health check + spawn if missing
│   ├── peer-context.ts        # getGitRoot, getTty, getPid
│   └── summarize.ts           # gpt-5.4-nano auto-summary
├── package.json               # Bun deps, no Node
├── tsconfig.json
├── README.md                  # Install + usage instructions
├── bun.lock
└── docs/superpowers/specs/
    └── 2026-04-13-agent-peers-mcp-design.md   # this file
```

---

## 5. Components

### 5.1 `broker.ts`

HTTP daemon on `127.0.0.1:7900`. Uses `Bun.serve()` and `bun:sqlite`.

**PeerId format:** UUID v4, generated via `crypto.randomUUID()` on `/register`. Opaque string ~36 chars. Returned to client as-is; client stores and echoes back on every subsequent call.

**Endpoints (POST, JSON):**
| Path | Request | Response |
|---|---|---|
| `/health` | (GET) | 200 OK |
| `/register` | `RegisterRequest` (incl. `peer_type`, optional `name`) | `{ id, name }` |
| `/heartbeat` | `{ id }` | `{ ok: true }` |
| `/unregister` | `{ id }` | `{ ok: true }` |
| `/set-summary` | `{ id, summary }` | `{ ok: true }` |
| `/list-peers` | `{ scope, cwd, git_root, exclude_id?, peer_type? }` | `Peer[]` (each includes `name`) |
| `/send-message` | `{ from_id, to_id_or_name, text }` | `{ ok, error?, id? }` |
| `/poll-messages` | `{ id }` | `{ messages: LeasedMessage[] }` (each carries `lease_token`) |
| `/ack-messages` *(new)* | `{ id, lease_tokens: string[] }` | `{ ok: true, acked: number }` |
| `/rename-peer` *(new)* | `{ id, new_name }` | `{ ok, error?, name? }` |

**Behavior:**

*Leased delivery (Phase 1 primitive):*
- On `/poll-messages`, broker selects all messages for the peer where `acked=0 AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())`. In the same SQL transaction, each selected row gets a fresh `lease_token = crypto.randomUUID()` and `lease_expires_at = now() + 30s`. Response includes each message's `lease_token`.
- On `/ack-messages`, broker marks rows with matching `lease_tokens` as `acked=1` **only if** `lease_expires_at >= now()` at the time of ack (stale acks explicitly ignored — addresses Codex review-2 finding). If the ack arrives late, the `UPDATE` matches zero rows and the broker's response reports `acked: 0`; the message will be re-leased on the next poll and re-delivered.
- If the client never acks at all (crash, MCP transport failure), the lease expires and the same message is returned on the next poll. The client is responsible for deduplication via the immutable `message_id` (see §5.4 and §5.5 "seen-set" patterns).

*Atomic name allocation (addresses Codex review-2 finding):*
- `/register` and `/rename-peer` never do read-then-write. They execute `INSERT` (or `UPDATE`) inside a transaction; on SQLite `UNIQUE` violation, catch the exception and try the next suffix. For `/register`, the retry ladder is `name`, `name-2`, `name-3`, ..., `name-99`, then auto-generate. For `/rename-peer`, a `UNIQUE` violation returns `{ ok: false, error: "name taken" }` deterministically — no retry ladder because rename has caller-specified target.
- Concurrent `/register` with identical `PEER_NAME` is therefore deterministic: one succeeds, the other gets the next free suffix. No 500-class errors surface to the caller.

*Timer-driven peer GC with orphan preservation (revised per Codex review-2):*
- `setInterval(gcStalePeers, 30_000)` runs inside the broker process. Deletes peers whose `last_seen` is > 60s old.
- **Does NOT delete undelivered messages addressed to GC'd peers.** Instead the messages stay in the DB with their `to_id` intact, no longer routable (nobody polls for them), but visible to `cli.ts orphaned-messages` for operator inspection. This means "send succeeded, then recipient died before delivery" is observable to the operator rather than silently discarded.
- `/send-message` still runs a liveness check on the resolved target (last_seen < 60s). If stale, returns `{ ok: false, error: "target peer stale" }` up front so the sender sees the problem before the message is written.
- `/rename-peer` and `/heartbeat` also refresh `last_seen`.

*Known limitation — "accepted for delivery" is best-effort:*
A `send_message` returning `ok: true` means the message was durably written to the broker and the target was alive at that moment. It does **not** guarantee delivery: the target can die between accept and the recipient's next poll. This is an honest contract; observability is via `cli.ts orphaned-messages`. Phase 2 may add sender-side delivery receipts (callback when message is acked) if the user wants stronger guarantees.

**Startup ordering (load-bearing):**
Broker must fully initialize SQLite — open the DB file, run all `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements, enable WAL mode — **before** calling `Bun.serve({ port: 7900, ... })`, AND before starting the GC timer. Implementation: DB init is synchronous (bun:sqlite is sync), so ordering is just top-to-bottom statement order inside `main()`; GC timer is started after `Bun.serve` resolves.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS peers (
  id            TEXT PRIMARY KEY,             -- immutable UUID, broker's canonical identity
  name          TEXT NOT NULL UNIQUE,         -- mutable human-readable label (see §5.7)
  peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
  pid           INTEGER,
  cwd           TEXT,
  git_root      TEXT,
  tty           TEXT,
  summary       TEXT DEFAULT '',
  registered_at TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id           TEXT NOT NULL,
  to_id             TEXT NOT NULL,
  text              TEXT NOT NULL,
  sent_at           TEXT NOT NULL,
  acked             INTEGER NOT NULL DEFAULT 0,  -- 0 = pending/leased, 1 = acked
  lease_token       TEXT,                         -- set on poll, cleared on ack
  lease_expires_at  TEXT                          -- ISO timestamp; message re-pollable after this
);

-- Pollable rows: unacked AND (no lease OR lease expired).
-- Using a compound index on (to_id, acked) is enough; the lease check is a filter.
CREATE INDEX IF NOT EXISTS idx_messages_to_acked
  ON messages(to_id, acked);

CREATE INDEX IF NOT EXISTS idx_peers_last_seen
  ON peers(last_seen);
```

WAL mode on for concurrent reads. Single writer (the broker process) so no contention concerns.

**Singleton enforcement:** broker uses `Bun.serve({ port: 7900 })` which throws on EADDRINUSE → if a second broker tries to start it dies cleanly. The `ensureBroker` helper handles this race.

### 5.2 `shared/broker-client.ts`

Thin HTTP wrapper. Exports typed functions:
```ts
register(req: RegisterRequest): Promise<RegisterResponse>
heartbeat(id: PeerId): Promise<void>
unregister(id: PeerId): Promise<void>
setSummary(id: PeerId, summary: string): Promise<void>
listPeers(req: ListPeersRequest): Promise<Peer[]>
sendMessage(req: SendMessageRequest): Promise<{ ok: boolean; error?: string }>
pollMessages(id: PeerId): Promise<Message[]>
isAlive(): Promise<boolean>
```

All other modules go through this. Wire format changes happen in one place.

### 5.3 `shared/ensure-broker.ts`

Reused from existing claude-peers-mcp pattern, adapted for new port/script path. On first call:
1. `isAlive()` → if true, return
2. Resolve the broker script path via `fileURLToPath(new URL("../broker.ts", import.meta.url))` **not** `.pathname`. This is mandatory because the project path `/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp` contains a space AND an apostrophe, which `URL.pathname` returns URL-encoded (`%27`, `%20`). `fileURLToPath` decodes correctly; passing the encoded form to `Bun.spawn` would fail with ENOENT.
3. `Bun.spawn(["bun", brokerScript])` with `stdio: ["ignore", "ignore", "inherit"]`, `proc.unref()` so MCP server can exit independently
4. Poll `isAlive()` every 200ms for 6s; throw if never up

Same rule applies everywhere we derive a filesystem path from `import.meta.url` — always use `fileURLToPath`.

### 5.4 `claude-server.ts`

Behavior identical to existing `claude-peers-mcp/server.ts`, with these differences:
- Uses `shared/broker-client.ts` instead of inline fetch
- Connects to broker on port 7900
- Registers with `peer_type: "claude"`
- MCP server `name` is `"agent-peers"` (so it's distinct in client's MCP list)
- `instructions` field uses the new naming (see exact text below)

Tools: `list_peers`, `send_message`, `set_summary`, `check_messages`, `rename_peer`.
Polling: every 1s, push via `notifications/claude/channel`. **Deterministic dedupe via in-memory seen-set**: the server keeps a `Set<number>` of `message_id`s it has already pushed successfully in this session. On each poll tick:
1. For each leased message `m`, check `seen.has(m.id)`.
   - If yes → this is a re-delivery due to a lost ack. Skip `mcp.notification()`, but still include `m.lease_token` in the ack batch so the broker's stuck lease can finally close.
   - If no → call `mcp.notification()`. On success, `seen.add(m.id)` THEN queue `m.lease_token` for the ack batch. On failure, leave `seen` alone and skip the ack so the lease expires cleanly and gets retried.
2. After the per-message loop, issue a single `/ack-messages` call for all collected tokens. Ack failure is fine — next poll will re-attempt.

The seen-set is in-memory only. On process restart, it starts empty, but any previously-delivered message has also been acked before the restart (or its lease has expired in the broker), so there's no stale state to reconcile.

Heartbeat: every 15s.

**Claude `instructions` field (exact text):**
```
You are connected to the agent-peers network. Other AI agents on this 
machine (Claude Code or Codex CLI sessions) can see you and send you 
messages.

IMPORTANT: When you receive a <channel source="agent-peers" ...> message, 
RESPOND IMMEDIATELY. Do not wait until your current task is finished. 
Pause what you are doing, reply to the message using send_message, then 
resume your work. Treat incoming peer messages like a coworker tapping 
you on the shoulder — answer right away, even if you are in the middle 
of something.

Read the from_id, from_peer_type, from_summary, and from_cwd attributes 
to understand who sent the message. Reply by calling send_message with 
their from_id.

On startup, proactively call set_summary to describe what you are 
working on. This helps other peers understand your context.

Available tools:
- list_peers (scope: machine|directory|repo, optional peer_type filter)
- send_message (to_id, message)
- set_summary (summary)
- check_messages (manual inbox check; not normally needed because 
  messages are pushed via channel)
```

The channel notification payload `meta` field includes **both** `from_peer_type` (claude/codex) AND `from_name` (human label) alongside the existing `from_id`, `from_summary`, `from_cwd`, `sent_at`. The receiving Claude can therefore see e.g. "message from frontend-tab (claude)" without any extra lookup.

### 5.5 `codex-server.ts`

Same MCP server skeleton, **without** `claude/channel` capability. Differences from claude-server.ts:
- Capabilities: `{ tools: {} }` only
- **Piggyback delivery on every tool handler** with **ack-on-next-call** (revised per Codex review-2 to avoid "ack before transport confirmation" silent-loss).
- Registers with `peer_type: "codex"`
- Heartbeat still runs every 15s (independent of messaging)
- `instructions` field is informational only — design does not depend on Codex honoring it (see §6)

**Ack-on-next-call pattern (revised after Codex review round-3):**

The codex-server holds a module-level `pendingAcks: string[]` (lease tokens from the previous tool call) and a `seen: Set<number>` of message IDs it has already polled in this session.

Every tool handler does, in order:
1. **Flush the previous call's pending acks** — if `pendingAcks.length > 0`, call `/ack-messages`. A subsequent request arriving IS a strong heuristic that the previous response cycle completed (Codex's MCP client is alive and issuing new requests). It is **not a cryptographic proof** — a prior response could in theory be lost after handler return while the same Codex process keeps issuing requests, and in that narrow case an ack would fire without the message ever reaching the model. See "Residual limitations" below.
2. **Poll for new messages**. For each polled message: if `seen.has(m.id)` this is a re-delivery due to a lost ack; queue its lease_token for next-call ack, do not re-inject. Else `seen.add(m.id)`, queue its lease_token in `pendingAcks`, and include it in this call's inbox block.
3. **Run the tool's own logic**.
4. **Return response with inbox block prepended**.

**On clean shutdown (SIGINT/SIGTERM), `pendingAcks` is NOT flushed.** Those tokens belong to the most recent response whose delivery we cannot confirm. Flushing them on exit would re-introduce silent loss. Instead we unregister the peer (which releases its row for GC but preserves undelivered messages as orphans) and exit. Leases expire 30s later and are re-leased on the next session's first poll.

**On transport failure (stdout write error, Codex MCP client disconnect)**: if Codex's MCP client abandons the connection, the session is effectively dead — no more tool calls means no more flushes, leases expire, next session re-delivers. If Codex's MCP client stays alive and merely drops one malformed response, the narrow silent-loss window below applies.

**Residual limitations (Phase 1 accepts these, Phase 2 may address):**
- `seen.add` happens at poll time, not at proven-delivery time. A message injected into a response that fails to reach the model is marked as seen in the server's memory and as acked in the broker as soon as a subsequent tool call fires. Recovery requires the Codex session to die (fresh process, fresh seen-set) or the user to re-send.
- The only way to close this fully is an explicit client receipt — a tool call from Codex echoing the `message_id` after the model has acted on it. That would reintroduce prompt-obedience dependence. Phase 2 will explore this as an opt-in stricter mode.
- The operator-visible safety net is `cli.ts orphaned-messages`, which shows all undelivered messages when their recipient disappears.

The Phase 1 contract is therefore: **best-effort delivery with observability for the observable failure modes (recipient-death-after-accept, broker crash).** Silent loss is possible only in the narrow window where the Codex MCP client remains live and responsive but loses a specific response mid-transport. This is a substantially narrower failure surface than any of the prior designs.

Tools: `list_peers`, `send_message`, `set_summary`, `check_messages`, `rename_peer` (same names as claude-server for consistency — peers don't need to know what type they're talking to).

`check_messages` becomes effectively equivalent to "no-op tool that causes a poll" — it exists so a user can explicitly ask "check now" without needing another tool call. Since every tool call already polls, invoking `list_peers` would show pending messages too. That is intentional redundancy: whatever tool Codex calls, inbox is delivered.

**Piggyback block format (exact template — self-contained, no dependence on separate instructions):**

When the inbox is empty, the response is whatever the tool normally returns, unchanged.

When there are N pending messages, the response text is prefixed with:

```
[PEER INBOX] 2 new peer message(s) — respond to each via send_message(to_id=<from_name>, message="...")

--- msg 1 of 2 ---
message_id: 42
from: frontend-tab (claude, cwd=/Users/.../openhedge-web)
sent_at: 2026-04-13T22:14:07Z
text:
<message body here, preserved verbatim>

--- msg 2 of 2 ---
message_id: 43
from: backend-codex (codex, cwd=/Users/.../openhedge-api)
sent_at: 2026-04-13T22:14:11Z
text:
<message body here>

--- end peer inbox ---
```

The `message_id` is the broker's monotonic autoincrement row id — stable and globally unique within this broker's DB. Codex can use it to detect duplicates on re-delivery (if ack was lost and the message gets re-leased on the next poll).

The reply hint (`respond via send_message(...)`) is inlined in every block so Codex learns the protocol from the tool output itself, not from the `instructions` field or any external file. This removes the load-bearing prompt-obedience assumption Codex's adversarial review flagged.

**`list_peers` tool schema adds optional `peer_type` filter** to match the broker's capability:
```json
{
  "scope": { "enum": ["machine", "directory", "repo"] },
  "peer_type": { "enum": ["claude", "codex"], "optional": true }
}
```
When omitted, returns peers of all types. `list_peers` output shows `peer_type` for each peer on its own line.

### 5.6 `cli.ts`

Reused from existing pattern, repointed at port 7900. Subcommands:
- `bun cli.ts status` — broker health + peer list with peer_type and name columns
- `bun cli.ts peers` — peer list only (shows `name` prominently, id as secondary)
- `bun cli.ts send <name-or-id> <message>` — inject a message into a session (accepts name OR UUID)
- `bun cli.ts rename <name-or-id> <new-name>` — admin rename a peer
- `bun cli.ts orphaned-messages` — list messages whose `to_id` no longer matches any active peer (from recipient-death-after-accept). Shows `id, from_id, to_id, sent_at, text preview`. Phase 2 may add an option to re-route or purge.
- `bun cli.ts kill-broker` — stop daemon

### 5.7 Identity & naming (rationale, schema, tools, flows)

**Problem.** When a user has N Claude/Codex sessions open, they cannot tell them apart — `cwd`/`git_root` collide when multiple tabs share a repo, UUIDs are unreadable, model-written `summary` is descriptive not canonical. We need a stable human-friendly handle that is also first-class in the messaging API.

**Design.** Two columns side by side:
- `id` (UUID) — **immutable, broker-canonical identity**. Never changes. Used internally for routing.
- `name` — **mutable human-readable label**. Every peer has one at all times. Unique across active peers. Used in all user-facing surfaces (`list_peers` output, `send_message` target, CLI).

This separation is the classic primary-key vs display-label pattern. Renaming a peer never breaks routing because message rows reference `id`, not `name`.

**Name provisioning (in priority order, top wins):**
1. **Explicit user override at launch:** `PEER_NAME=frontend-tab agentpeers` — server reads `process.env.PEER_NAME` and passes it to `/register`. If taken, broker appends `-2`, `-3`, ...
2. **Auto-generated friendly name:** if `PEER_NAME` is unset, broker picks a random `<adjective>-<noun>` from a wordlist (≥ 50 adj × 50 noun = 2500 combos; collision re-draws up to 10 times then appends numeric suffix). Examples: `calm-fox`, `swift-panda`, `loud-otter`.

Wordlist lives at `shared/names.ts`. Keep it tight and PG — avoid anything embarrassing to paste into logs.

**Terminal tab title (zero-effort glance identification):**
After successful register, the MCP server writes the OSC-0 escape sequence to `/dev/tty`:
```
\x1b]0;peer:<name>\x07
```
The terminal emulator (iTerm2, Terminal.app, Ghostty, kitty, alacritty, wezterm) renders this as the tab title, so the user sees e.g. `peer:calm-fox` on the tab header. No action required.

Implementation detail: open `/dev/tty` for write via `Bun.file("/dev/tty").writer()` or `fs.openSync("/dev/tty", "w")`. Wrap the entire write in a try/catch — any error (no controlling TTY, permission denied, closed pty, unknown OS) must be swallowed and logged to stderr. Terminal title is a cosmetic affordance; failing it must never crash the MCP server. Gate the feature behind env var `AGENT_PEERS_DISABLE_TAB_TITLE=1` as an escape hatch in case a terminal emulator mishandles the escape.

On rename, re-emit the escape sequence so the tab title updates live.

**Lookup in `send_message`:**
The broker's `/send-message` endpoint accepts `to_id` as either a UUID or a name. Resolution order:
1. If `to_id` matches a `peers.id`, use it directly.
2. Else try `SELECT id FROM peers WHERE name = ?`. If found, use that id.
3. Else return `{ ok: false, error: "unknown peer: <input>" }`.

This means `send_message(to="frontend-tab", text=...)` just works. UUID still works too (defensively).

**`rename_peer` tool schema — self-rename only in Phase 1 (per Codex adversarial review):**
```json
{
  "name": "rename_peer",
  "description": "Rename YOURSELF (the calling peer). Takes a single argument new_name. Admin rename of other peers is intentionally not exposed as an MCP tool to prevent one peer from impersonating another; if you need to rename another peer, use `bun cli.ts rename <name-or-id> <new_name>` from a terminal (operator action).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "new_name": { "type": "string" }
    },
    "required": ["new_name"]
  }
}
```

Broker endpoint `/rename-peer` handles this:
- Validates `new_name` (non-empty, **≤ 32 chars**, matches `^[a-zA-Z0-9_-]+$` — URL-safe chars only for shell-friendliness). The 32-char cap deliberately excludes UUID format (36 chars) so `send_message` cannot route ambiguously between a name and an id.
- Rejects duplicates with `{ ok: false, error: "name taken" }`
- On success, returns new name and updates `last_seen` in the same transaction (prevents GC racing a live session that just renamed)

After rename, the renaming peer re-emits the terminal tab title escape to reflect the new name.

**CLI admin rename stays available locally only:**
`bun cli.ts rename <name-or-id> <new_name>` talks to the same `/rename-peer` endpoint but identifies the target directly by name or id (not by caller session). This is an operator-initiated action on the local machine — it carries no cross-peer trust boundary because it's a human at the keyboard on the same host, not a remote peer.

**Ping/identify tool — deferred to Phase 2.** For the rare case where user cannot tell sessions apart even with tab titles (e.g. minimized windows), Phase 2 will add an `identify_peer(target_id)` tool that sends the target a short "IDENTIFY: you are peer <name>" message and a terminal bell. Phase 1 does not include this — auto-names + tab titles solve the common case.

**`list_peers` output format (updated):**
```
Found 3 peer(s) (scope: machine):

Peer frontend-tab (claude)
  ID: 7b1a...f44c
  CWD: /Users/.../openhedge-web
  TTY: /dev/ttys002
  Summary: Wiring the landing page hero
  Last seen: 3s ago

Peer calm-fox (claude)
  ID: 9c2d...8e1a
  CWD: /Users/.../openhedge-web
  TTY: /dev/ttys005
  Summary: Running vitest in watch mode
  Last seen: 1s ago

Peer backend-codex (codex)
  ID: 2a4b...112e
  CWD: /Users/.../openhedge-api
  TTY: /dev/ttys007
  Summary: Refactoring the order book matcher
  Last seen: 12s ago
```

Name prints first on each entry so the user scans it at a glance.

**Channel push metadata carries name too:** when claude-server pushes a channel notification, meta includes `from_name` alongside `from_id`, so the receiving Claude sees "message from frontend-tab" without a separate lookup.

**API deltas summary:**
| Endpoint | Change |
|---|---|
| `/register` | Accepts optional `name` field (from `PEER_NAME` env); broker generates one if missing. Response returns `{ id, name }`. |
| `/list-peers` | Response peer objects include `name`. |
| `/send-message` | `to_id` field accepts name OR UUID. |
| `/rename-peer` *(new)* | `{ id, new_name }` → `{ ok, error?, name? }` |
| `/poll-messages` | Message objects include `from_name` for convenience. |

---

## 6. Codex `instructions` field — informational only after piggyback

After Codex's adversarial review, the design **no longer depends on the `instructions` field for correctness**. Piggyback delivery puts the `[PEER INBOX]` block (with inline reply hint) directly into every tool response Codex receives; the protocol is teachable from a single tool output regardless of whether Codex's MCP client surfaces the `initialize` instructions string. The field is still populated — well-behaved clients benefit from it — but nothing breaks if Codex ignores it.

**No global mutation of `~/.codex/AGENTS.md`.** The previous fallback of appending protocol text to the user's global Codex agents file has been removed — it violated isolation goals (affecting every Codex session system-wide, not just this project) and was unnecessary once piggyback became deterministic. If the user wants an explicit project-local hint, they can add it to a project-level `AGENTS.md` in the specific repo where they run Codex; the README will mention this as optional.

The exact string passed when constructing the MCP server:

```
You are connected to the agent-peers network — other AI agents on this 
machine (Claude Code or Codex CLI sessions) can discover you and send you 
messages.

INBOX HANDLING:
- Any tool call on this MCP automatically surfaces pending peer messages: 
  if there are any, the response text starts with a [PEER INBOX] block 
  listing them with inline reply hints. You do NOT need to call anything 
  special — list_peers, set_summary, even a send_message will all pick up 
  your inbox.
- check_messages is a convenience trigger that does only the inbox surfacing 
  (and nothing else). Use it when you have no other tool call to make but 
  want to poke for messages.
- When you see a [PEER INBOX] block, treat each message like a coworker's 
  Slack message: finish your current step, then respond via 
  send_message(to_id=<from_name>, message="..."). The from_name and 
  message_id are inside the block.

ON STARTUP:
- Call set_summary once with a 1-2 sentence description of what you are 
  working on. Other peers see this when they list peers.

PEER DISCOVERY:
- Use list_peers with scope="machine" to see all agents, "directory" for 
  same cwd, "repo" for same git repo.
- Each peer has a human-readable "name" (e.g. "frontend-tab", "calm-fox") 
  and an immutable UUID "id". The peer_type field tells you whether they 
  are "claude" or "codex" — both send and receive messages identically.

TOOLS:
- list_peers(scope, peer_type?) — discover other agents
- send_message(to_id, message) — message a peer. to_id accepts UUID or name 
  (prefer the name for readability).
- set_summary(summary) — describe your current work
- check_messages — convenience trigger to surface the inbox (same effect 
  as any other tool call; does nothing else)
- rename_peer(new_name) — rename YOURSELF only. Names are 1-32 chars, 
  [a-zA-Z0-9_-], and must be unique among active peers. You cannot rename 
  other peers from this tool (admin rename is only available via the 
  local `bun cli.ts rename ...` command by the operator).
```

---

## 7. Data flow

All four flows use the same lease + ack primitive. Differences are only in *how* the recipient-side server delivers the message to its agent (channel push for Claude, piggyback for Codex).

### 7.1 Claude → Claude
1. Claude A calls `send_message(to="frontend-tab", text="…")`
2. claude-server A → `/send-message` (after broker liveness-checks target; rejects if stale)
3. claude-server B's 1s polling loop → `/poll-messages` → broker leases the row (lease_token set, 30s expiry)
4. claude-server B → `mcp.notification("notifications/claude/channel", ...)` — Claude B sees it mid-task
5. On notification resolve, claude-server B → `/ack-messages` → broker marks acked

If step 4 throws or step 5 fails, the lease expires → next poll re-delivers. Claude dedupes by `message_id` in `meta`.

### 7.2 Claude → Codex
1. Claude A calls `send_message(to="backend-codex", text="…")`
2. claude-server A → `/send-message` (same liveness check)
3. codex-server X has no timer poll. Next time Codex calls **any** tool on this MCP (`list_peers`, `send_message`, `set_summary`, `check_messages`, `rename_peer`):
   - **Flush previous call's acks first** — if `pendingAcks` is non-empty, call `/ack-messages` now (heuristic confirmation that the previous response cycle succeeded; see §5.5 on the narrow residual-loss window this does NOT fully close).
   - Call `/poll-messages` → broker leases any pending messages for this peer and returns them with fresh lease tokens.
   - For each polled message: if `seen.has(m.id)` queue its lease_token in `pendingAcks` and do NOT re-inject. Else `seen.add(m.id)`, push the lease_token into `pendingAcks`, and include the message in the inbox block built for this response.
   - Run the tool's own logic.
   - Return response with the inbox block prepended.
   - **Do NOT ack inside this handler.** The tokens in `pendingAcks` will be flushed by the NEXT tool call.
4. Codex sees the `[PEER INBOX]` block in the tool output and responds via `send_message(to_id="frontend-tab", …)`. The reply hint is inline in every block.

Latency: bounded by Codex issuing another tool call. Every-step tool usage (common in Codex) keeps this sub-second. If Codex is idle, messages wait at the broker until the next tool call. If Codex crashes before the next call, leases expire after 30s and the next session re-leases + re-injects.

### 7.3 Codex → Claude
1. Codex calls `send_message(to="frontend-tab", text="…")`
   - codex-server's send_message handler first polls and pipes any pending inbox for Codex itself into the response (piggyback applies to all tools uniformly)
   - then posts `/send-message` to broker, which liveness-checks Claude A
2. claude-server A's 1s polling loop picks up the message → channel push → ack (as §7.1)

Instant from Claude's perspective. `send_message` response that Codex sees confirms the send plus surfaces any incoming inbox that happened to be pending.

### 7.4 Codex → Codex
Same as 7.2 but recipient is also Codex (piggybacks into its own next tool call).

---

## 8. Install (README contents, no script)

### 8.1 Setup
```bash
cd "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp"
bun install
```

### 8.2 Register MCP for Claude Code
```bash
claude mcp add --scope user --transport stdio agent-peers -- \
  bun "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/claude-server.ts"
```

### 8.3 Register MCP for Codex CLI
Append to `~/.codex/config.toml`:
```toml
[mcp_servers.agent-peers]
command = "bun"
args = ["/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/codex-server.ts"]
```

### 8.4 Add zsh alias for Claude launcher
Append to `~/.zshrc`:
```bash
alias agentpeers='claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'
```

### 8.4.1 (optional) Pre-name a session at launch
```bash
# assigns the name "frontend-tab" instead of an auto-generated one
PEER_NAME=frontend-tab agentpeers
```
For Codex, export before launch: `export PEER_NAME=backend-codex && codex`. Inside any session, renaming later is done via the `rename_peer` MCP tool.

### 8.5 Verify
```bash
# Terminal 1
agentpeers

# Terminal 2
codex   # Codex auto-loads MCP from config.toml

# In either: ask "list all peers on this machine"
```

---

## 9. Error handling

| Failure | Behavior |
|---|---|
| Broker not running on first server start | `ensureBroker()` spawns it; throws after 6s if cannot start |
| Broker dies during session | All broker calls fail → MCP tool returns error message → user/agent sees the failure → restart session to recover (Phase 2 will add reconnect). Messages already leased but not acked survive broker restart (they're in SQLite, lease expires in 30s, next poll re-delivers). |
| Client polled a message but crashed before ack | Lease expires after 30s → message re-polled on next request → retry transparent to sender. Recipient dedupes by `message_id` via in-memory seen-set (§5.4, §5.5). |
| `mcp.notification()` throws on Claude push | Server does NOT add to seen-set and does NOT ack. Lease expires → next poll re-pushes. Claude dedupes. |
| Codex tool response fails to reach Codex (transport error) | `pendingAcks` never flushed → leases expire → next poll re-leases and re-injects (seen-set caught up when previous inject succeeded, but since the transport failed the whole session may be gone too). |
| Stale `/ack-messages` arrives after lease expiry | Broker's `lease_expires_at >= now()` predicate rejects it (`acked: 0` returned) → message stays pollable → next poll re-delivers. |
| Two peers concurrently register with identical `PEER_NAME` | Broker's atomic INSERT + UNIQUE-violation retry ladder assigns `name`, `name-2`, `name-3`, ... deterministically. No 500-class errors. |
| Two peers concurrently rename to the same `new_name` | Broker's atomic UPDATE + UNIQUE-violation catch returns `{ ok: false, error: "name taken" }` to the loser. Winner keeps new name. |
| Send succeeds, target dies before poll | `send_message` returns `ok: true` (honest best-effort contract). GC does NOT delete the undelivered row — it stays as an orphan, surfaced via `cli.ts orphaned-messages`. |
| `send_message` to unknown peer (bad id/name) | Broker returns `{ ok: false, error: "unknown peer" }` → tool returns visible error |
| `send_message` to **stale** peer (alive in DB but heartbeat > 60s old) | Broker returns `{ ok: false, error: "target peer stale" }` → sender sees it and can pick a different target or retry later |
| Auto-summary (gpt-5.4-nano) fails | Logged to stderr, peer registers with empty summary |
| Port 7900 already in use | Broker spawn fails → `ensureBroker` throws → user sees clear error in stderr; resolution is `lsof -i :7900` |
| Peer crashes without unregister | Heartbeat stops → broker GCs peer within 30s–90s (timer fires every 30s, threshold is 60s). Undelivered messages addressed to the GC'd peer are **preserved** in the DB as orphans (not deleted — spec §5.1). `cli.ts orphaned-messages` surfaces them for the operator. Phase 2 may add TTL-based purge. |
| Two MCP servers race to spawn broker | Loser gets EADDRINUSE and dies; winner serves both — no harm |
| Concurrent rename to same new_name | UNIQUE constraint on `peers.name` → one succeeds, the other gets `{ ok: false, error: "name taken" }` — deterministic, no duplication possible |
| Terminal title write fails (no tty, permission, closed pty) | Swallowed, logged once to stderr. MCP server keeps running. Tab title is cosmetic. |

All errors go to stderr (MCP stdio convention — stdout is reserved for protocol).

---

## 10. Testing

Manual end-to-end tests, in order:
1. **Broker boot** — `bun broker.ts` direct, hit `/health`
2. **Single Claude registers** — start `agentpeers`, run `bun cli.ts peers`, see entry with peer_type=claude
3. **Two Claudes message** — open two `agentpeers` terminals, send between them, confirm push works
4. **Single Codex registers** — `codex` with config entry, run `bun cli.ts peers`, see entry with peer_type=codex
5. **Codex check_messages empty** — call check_messages, get "no messages" response
6. **Claude → Codex** — Claude session sends to Codex peer; Codex calls check_messages, sees it
7. **Codex → Claude** — Codex sends to Claude peer; Claude receives instant push
8. **Codex → Codex** — two Codex sessions message each other via check_messages
9. **Mixed list_peers** — Claude lists peers, sees both Claude and Codex peers with type column
10. **Crash recovery** — kill broker mid-session; confirm next call shows error; restart broker; restart sessions; everything works again

Automated tests (Phase 1, minimal): `bun test` for `shared/broker-client.ts` against a live test broker on port 7901.

---

## 11. Open questions / non-goals

**Non-goals for Phase 1:**
- Cross-machine peers (single localhost only — same as upstream)
- Authentication (single-user machine, localhost only — same as upstream)
- Encryption (same)
- Replacing the existing stable `claude-peers-mcp` (it stays running)
- Auto-detection of agent type (we use two binaries — explicit beats clever)
- Message TTL / retention policy — undelivered messages accumulate in `~/.agent-peers.db` forever if a Codex peer never calls `check_messages`. Volume is trivial (text only, tiny rows) and a manual `bun cli.ts kill-broker && rm ~/.agent-peers.db` fully resets state. Phase 2 may add a TTL if accumulation becomes measurable.

**Resolved:**
- Codex MCP config format → confirmed `[mcp_servers.NAME]` TOML block via inspection of user's existing config.toml
- Broker port → 7900
- Naming → `agent-peers` (MCP), `agentpeers` (alias), `agent-peers-mcp` (folder/repo)

---

## 12. Change log

- 2026-04-13 — Initial spec written. Phase 1 scope locked. Approved by user.
- 2026-04-13 — Added §5.7 Identity & naming system. Immutable UUID `id` + mutable `name` column, auto-generated adjective-noun names, `PEER_NAME` env override, terminal tab title via OSC escape, `rename_peer` tool, `send_message` accepts name or id. Motivated by user's PR-workflow need for stable human-readable handles across sessions.
- 2026-04-13 — Incorporated Codex adversarial review round 4 findings:
  - [high] §7.2 data-flow description still showed same-call ack after handler return → rewrote to match §5.5 ack-on-next-call exactly. The two sections now describe the same Codex contract.
  - [high] §6 Codex `instructions` text still said Codex "must" call `check_messages` (obsolete) and implied `rename_peer` could target other peers (security-regression implication) → rewrote to reflect piggyback-on-any-tool and self-rename-only.
  - [medium] `pollMessages` heartbeat was outside the transaction → failed polls still refreshed `last_seen`. Moved heartbeat INSIDE the `db.transaction(() => {...})` body so a thrown poll rolls back the liveness bump. Added regression test `pollMessages heartbeat is rolled back if tx throws`.
  - [medium] Plan's manual smoke tests only validated `check_messages` as the Codex inbox trigger → added Task 25 covering (a) shutdown-without-flush preserving messages across restart, (b) Codex inbox surfacing on `list_peers` without calling `check_messages`, (c) residual narrow-window documentation cross-check.

- 2026-04-13 — Incorporated Codex adversarial review round 3 findings:
  - [critical] Cleanup on SIGINT/SIGTERM was flushing `pendingAcks` → silent loss on shutdown → removed. Leases now expire naturally after process death.
  - [high] "Next tool call = proof of previous delivery" claim was too strong → softened to "strong heuristic, not proof" with honest documentation of residual narrow window (stdout-fails-but-MCP-session-survives). Phase 2 may add explicit client receipts.
  - [medium] Claude `check_messages` tool was polling + acking inside the handler → same ack-before-delivery-confirmed bug. Replaced with passive "messages arrive via channel, nothing to do" response. The 1s push loop remains the sole ack path on Claude.
  - [medium] Error-handling table still said GC deletes unacked messages "in same transaction" → updated to explicitly say messages are preserved as orphans, removing the internal contradiction.

- 2026-04-13 — Incorporated Codex adversarial review round 2 findings:
  - [critical] Codex piggyback was acking before transport confirmation → replaced with **ack-on-next-call** pattern (§5.5). Ack happens when the NEXT tool call proves the PREVIOUS response landed. Crashes and transport failures cause lease expiry + re-delivery, never silent loss.
  - [high] Stale ack acceptance → broker's `/ack-messages` now requires `lease_expires_at >= now()` (§5.1). Late acks return `acked: 0` and the lease expires cleanly.
  - [high] GC silently deleted undelivered messages after recipient death → GC now preserves undelivered rows as **orphans** visible via `cli.ts orphaned-messages` (§5.1, §5.6). Accepted-then-lost is observable, not hidden.
  - [high] Register/rename name allocation race (read-then-insert) → replaced with atomic INSERT/UPDATE + UNIQUE-violation catch loop (§5.1). Concurrent registers with same `PEER_NAME` are deterministic.
  - [medium] Duplicate detection relied on model judgment → both servers now keep an in-memory `seen: Set<message_id>` and deterministically skip re-injection of already-delivered messages (§5.4, §5.5). No model intelligence required for correctness.
  - Spec now includes a "best-effort delivery" honest-contract note (§5.1) because lease+ack fixes poll-to-delivery loss but does not fix accept-to-recipient-death loss. Observability via orphan table replaces hiding that failure mode.

- 2026-04-13 — Incorporated Codex adversarial review round 1 findings:
  - Promoted explicit **lease + ack** message delivery from Phase 2 to Phase 1 (eliminates silent data loss when poll succeeds but delivery fails)
  - Replaced reactive `list_peers`-triggered GC with **broker-owned timer GC** every 30s + liveness checks on `/send-message` (prevents accepting messages for dead sessions; cleans up orphaned messages when peer is GC'd)
  - Restricted `rename_peer` MCP tool to **self-rename only**; admin rename stays in `cli.ts` as a local operator action (removes peer-to-peer impersonation risk)
  - Promoted **Codex piggyback delivery** from Phase 2 to Phase 1, with **self-contained `[PEER INBOX]` blocks** that inline the reply hint. Design no longer depends on Codex honoring the MCP `instructions` field, and the previous `~/.codex/AGENTS.md` global-mutation fallback is removed (protocol adherence is now deterministic, not prompt-dependent)
  - Updated schema: `messages` table gets `acked`, `lease_token`, `lease_expires_at` columns; new `/ack-messages` endpoint
  - Updated error-handling table with lease-expiry retry, stale-peer send rejection, GC-driven orphan cleanup, and terminal-title failure swallowing
