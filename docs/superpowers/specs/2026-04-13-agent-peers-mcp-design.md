# agent-peers-mcp — Design Spec

**Date:** 2026-04-13
**Status:** Phase 1 MVP design, approved; amended 2026-04-15 (see below)
**Goal:** Unified peer-discovery + messaging MCP supporting Claude Code AND Codex CLI sessions on the same broker, fully isolated from the existing stable `claude-peers-mcp` install.

---

## 2026-07-13 DELIVERY AMENDMENT (PR #12)

This amendment supersedes every confirm-on-next-call, `seen`, `pendingAcks`, and
presentation-implies-delivery statement below. Returning an MCP response—or
observing a later tool request—is not evidence that the model processed the
inbox.

Both adapters now persist leased messages in an owner-only durable inbox keyed
by immutable peer ID. They may present an unacknowledged message repeatedly.
Only the model's explicit `ack_messages(message_ids=[...])` invocation removes
matching local entries and acknowledges their current broker lease tokens.
Unknown IDs are reported without affecting other entries. If broker
acknowledgement fails or a lease has expired, the broker may later re-deliver a
safe duplicate; the implementation never converts that failure into silent
loss. Claude's channel remains a best-effort live presentation surface, while
Codex remains pull-only because current Codex clients do not surface MCP log
notifications to the model.

---

## 2026-04-15 AMENDMENTS (PR #2 — "fix message delivery")

The body of this spec remains the original Phase 1 design. Four deltas landed via PR #2 after adversarial review from `chatgpt-codex-connector[bot]` and a competing `feat/codex-conversation-flow` branch. Treat the bullets below as overriding any earlier text they contradict.

### A. Codex delivery: durable pipeline (confirmation rules superseded by the 2026-07-13 amendment)

The original §5.5 piggyback design gated delivery on an in-memory `seen` set populated at the moment a message was drawn into a tool response. Adversarial review showed this could silently lose messages when the MCP stdio response was dropped or aborted before reaching Codex's model. The amended design:

1. **Layer 1 — Durable on-disk inbox** at `~/.agent-peers-codex/<peer-id>.json`.
   - File perms 0o600, directory perms 0o700, fail-closed perm check on read (mirrors `broker.ts enforceDbFilePerms`, matches the security boundary established by rounds A–I).
   - Survives MCP process restart within the 60s reclaim window.
   - Module: `shared/codex-inbox.ts` (`CodexInboxStore`).
   - Background poll loop writes new leased messages here FIRST, before any model-visible delivery.

2. **Layer 2 — Signal-only preview push** via MCP `notifications/message` on each poll tick.
   - Carries ONLY `from_name` + `from_peer_type` + a pointer to where the authoritative delivery lands.
   - **No message body, no reply_action.** Prevents the double-reply risk where a Codex build that surfaces log notifications could reply from the preview, then reply again when the `[PEER INBOX]` block arrives.
   - Formatter: `shared/piggyback.ts → formatInboxPreview()`. Three regression tests guard this as a security-sensitive function.
   - Declared via `capabilities.logging: {}` on the codex-server.

3. **Layer 3 — Authoritative `[PEER INBOX]` block** on every agent-peers tool response.
   - Single source of truth: full body, sender metadata, sender summary, reply_action hint.
   - Drawn from the durable queue via `getUnreadMessages()` (NOT `consumeUnreadMessages()`) — items stay on disk until an explicit `ack_messages` call confirms their IDs.

4. **Explicit acknowledgement** keeps every durable entry eligible for presentation until the model calls `ack_messages` with that message ID. A re-leased copy refreshes the stored lease token without duplicating the durable entry.

### B. Broker: clear stale leases on reclaim

`registerPeer` now clears `lease_token` / `lease_expires_at` on unacked messages for the reclaimed peer. Previously, a Codex that died mid-delivery and was reclaimed by name would have its backlog held in "leased + not acked" state for up to `LEASE_DURATION_MS` (30s) before the broker re-offered it. The reclaim-time clear surfaces the backlog on the new session's first poll.

### C. Colleague behavior protocol

The original `claude-server` prompt said "RESPOND IMMEDIATELY" (§7.1) — wrong for the "colleagues coordinating across projects" use case, which rewards investigation + substantive replies over reflexive acknowledgement. Replaced with a shared behavioral protocol imported verbatim by both servers:

- **Module:** `shared/colleague-prompt.ts` (`COLLEAGUE_PROTOCOL` string).
- **Reactive rules:** acknowledge internally (not externally), investigate before responding, push back on disagreement, never leave a loop open, no auto-"got it" / "on it" chatter.
- **Proactive rules:** ping when you change something a peer's `summary` depends on, when you find an invariant relevant to their work, when blocked on them, when you finish a joint task, when you find something genuinely surprising. Explicit anti-patterns on progress chatter.
- **Maintenance rules:** keep `set_summary` current, update when focus shifts (especially redirected by peer), read peer summaries before pinging, use their naming.
- Worked example of the cross-project "merge two projects" flow so the model has a template for good collaboration.
- Each server's own `instructions` then adds a single paragraph about its specific delivery mechanism (channel push vs two-layer Codex pipeline) and composes it with the shared protocol.
- **`[PEER INBOX]` block framing softened** in `shared/piggyback.ts → formatInboxBlock()`: dropped the 🚨🚨🚨 "RESPOND BEFORE ANYTHING ELSE" banner, replaced with a four-path rubric (answer now / investigate / FYI / disagree) plus explicit forbidding of auto-acknowledgement. Includes sender's current summary when present.

### D. Test coverage

Test suite grew from 59 → 84. New coverage:
- `tests/broker.test.ts` — reclaim clears stale leases (round-trip: send → lease → crash → reclaim → verify backlog visible on first poll).
- `tests/codex-inbox-store.test.ts` — file perms 0o600 / dir 0o700, fail-closed load on wider perms, `removeByIds` + restart persistence + no-op-when-empty.
- `tests/piggyback.test.ts` — preview format carries sender identity + pointer, preview format does NOT leak body, preview format does NOT carry reply_action cues, inbox block includes sender summary when present.

### E. Superseded text in this document

- §5.4 "in-memory seen-set" — superseded by durable inboxes and explicit acknowledgement for both adapters.
- §5.5 "piggyback" — replaced by the three-layer pipeline above.
- §7.1 "RESPOND IMMEDIATELY" Claude prompt — replaced by `COLLEAGUE_PROTOCOL`.
- §7.2 Codex prompt — replaced by `COLLEAGUE_PROTOCOL` + delivery note.
- §9.1 "claude-server with channel push" / §9.2 "codex-server with piggyback" — still correct in broad shape but miss the durable-queue + preview-push layering.

Nothing else in the original spec is superseded — the broker protocol, security invariants, lease/ack primitive, orphan observability, reclaim semantics, self-rename tool, scope filters, and CLI admin actions are all unchanged.

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
- `codex-server.ts` with **background polling + queue-backed piggyback delivery** (poll broker every second, persist unread Codex messages locally, prepend them to the next response)
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
                  (push channel) (push channel) (queued inbox)
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
- If the client never explicitly acknowledges an ID (crash or MCP transport failure), the lease expires and the same message is returned on a later poll. Durable inbox upsert uses immutable `message_id` as its key (see §5.4 and §5.5).

*Atomic name allocation with stale-peer reclaim (addresses Codex reviews round-2 and round-5):*
- `/register` flow (atomic):
  1. **Reclaim fast-path**: if `PEER_NAME` is provided AND a peer with that exact name exists AND its `last_seen` is older than 60s, `UPDATE` that row in place — keep the existing `id` (UUID), refresh all process metadata (`pid`, `cwd`, `git_root`, `tty`, `peer_type`, `summary`, `last_seen`). Return `{ id: existing_uuid, name }`. This is the mechanism that makes "crash → restart with same PEER_NAME" recover undelivered messages: the restored peer row has the same UUID, so messages addressed to that UUID route correctly on the next poll.
  2. **Fresh INSERT path**: if reclaim did not apply, attempt `INSERT` with fresh UUID. On SQLite `UNIQUE` violation (name already taken by a LIVE peer), catch and advance through the suffix ladder `name`, `name-2`, `name-3`, ..., `name-99`, then auto-generated adjective-noun names. Each candidate is its own `INSERT` attempt — no read-then-write race.
- `/rename-peer` is an atomic `UPDATE`. A `UNIQUE` violation returns `{ ok: false, error: "name taken" }` deterministically — no retry ladder because rename has a caller-specified target.
- Concurrent `/register` with identical `PEER_NAME`: if both see the reclaim row as stale, one's `UPDATE` succeeds (changes=1), the other's sees `changes=0` (because the `last_seen < cutoff` predicate no longer matches after the first update refreshed it) and falls through to the INSERT ladder. If there is no stale row, both go straight to INSERT and the second gets the `-2` suffix. Deterministic, no 500-class errors.

*Reclaim window vs GC:*
- Reclaim requires the stale peer row to still exist. GC runs every 30s with a 60s staleness threshold, so an abandoned peer is removable roughly 60-90s after its last heartbeat. Restart within that window → UUID-preserving reclaim. Restart after GC removed the row → fresh INSERT with new UUID; messages to the old UUID become orphans (observable via `cli.ts orphaned-messages`).
- Graceful cleanup in the MCP servers deliberately does NOT call `/unregister`. Unregister removes the peer row immediately, defeating reclaim. Instead, on SIGINT/SIGTERM we just clear timers and exit; the broker's GC naturally reaps the now-heartbeat-less peer within 60-90s.

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

The Claude adapter registers with `peer_type: "claude"`, polls once per second,
and persists every leased message in an owner-only durable inbox keyed by the
immutable peer ID. For a newly persisted ID it also emits a best-effort
`notifications/claude/channel` event. Channel delivery is a presentation hint,
not acknowledgement evidence.

`check_messages` reads (without consuming) a bounded set from the durable inbox.
After processing messages, Claude calls `ack_messages(message_ids=[...])`.
Matching entries are removed locally and their current lease tokens are
acknowledged at the broker. Re-leases refresh the token for an existing ID and
do not generate duplicate live pushes while that ID remains queued.

The adapter retains its peer row on shutdown so a named restart can reclaim the
same UUID and the same durable inbox. Rename operations are serialized and the
identity file update uses credential-and-expected-name compare-and-swap; a
failed persistence update triggers a broker rename rollback.

Tools: `list_peers`, `send_message`, `set_summary`, `check_messages`,
`ack_messages`, `rename_peer`.

### 5.5 `codex-server.ts`

The Codex adapter registers with `peer_type: "codex"` and has no model-visible
mid-turn MCP push. Its one-second background poll persists leased messages in an
owner-only durable inbox keyed by immutable peer ID. It may emit a bodyless
`notifications/message` preview, but current Codex clients do not surface that
notification to the model; it is dormant future-compatible plumbing.

Every agent-peers tool call performs an immediate poll, reads a bounded set of
unacknowledged entries, and prepends them as the authoritative `[PEER INBOX]`
block. Entries are read rather than consumed, so a lost tool response does not
lose the message. The model must call `ack_messages(message_ids=[...])` after it
has processed those IDs. The acknowledgement response suppresses inbox
piggybacking so just-acknowledged content is not echoed again.

The explicit acknowledgement invocation is the delivery evidence. Local removal
happens before the broker request; if the broker request fails or a lease has
expired, the unacknowledged broker row becomes pollable again and produces a
safe duplicate. Unknown IDs are reported and do not affect other entries.
Shutdown clears timers but neither acknowledges entries nor unregisters the
peer, preserving restart recovery.

Tools: `list_peers`, `send_message`, `set_summary`, `check_messages`,
`ack_messages`, `rename_peer`.

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
1. Claude A calls `send_message` and the broker stores the row.
2. Claude B polls, leases, and durably persists it before presentation.
3. For a newly queued ID, Claude B receives a best-effort channel presentation.
4. The message remains available through `check_messages` until Claude B calls
   `ack_messages` with its ID.

### 7.2 Claude → Codex
1. Claude sends; the broker stores the row.
2. Codex's background poll leases and durably persists it.
3. Codex sees the authoritative `[PEER INBOX]` block on its next agent-peers tool
   response. There is no native model-visible MCP wake notification.
4. After processing it, Codex calls `ack_messages`; until then every eligible
   agent-peers response may re-present it.

### 7.3 Codex → Claude
The sender path is identical. Claude durably persists the leased row, may see a
live channel presentation, and explicitly acknowledges it after processing.

### 7.4 Codex → Codex
The receiver's background poll persists the row. The next agent-peers tool
response presents it, and explicit acknowledgement completes delivery. If the
receiver is idle, the message waits durably; the separate app-server wake design
is outside this Phase 1 delivery contract.

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
| Client persisted a message but crashed before explicit ack | Durable inbox survives restart under the reclaimed peer ID; the broker lease expires and re-poll refreshes the stored token. Delivery remains at-least-once. |
| `mcp.notification()` throws on Claude push | Durable inbox remains authoritative; `check_messages` can still present the message and no implicit ack occurs. |
| Codex tool response fails to reach Codex | No explicit ack occurs; the durable entry remains and is re-presented on a later agent-peers response or after restart. |
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
5. **Codex empty inbox** — Codex calls `list_peers`. Tool response has no `[PEER INBOX]` block (or block says zero messages). Calling `check_messages` is interchangeable but unnecessary.
6. **Claude → Codex** — Claude session sends to Codex peer; Codex's background poll picks it up and stores it locally; the next agent-peers response prepends a `[PEER INBOX]` block containing the message. `check_messages` is a freshness trigger, not a broker-only trigger.
7. **Codex → Claude** — Codex sends to Claude peer; Claude receives instant channel push
8. **Codex → Codex** — two Codex sessions message each other; the recipient's background poll queues the message and the next agent-peers response surfaces it regardless of which tool
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
- Message TTL / retention policy — orphaned messages (recipient died before any tool call surfaced them) accumulate in `~/.agent-peers.db` indefinitely. Visible via `cli.ts orphaned-messages`; manual purge via `bun cli.ts kill-broker && rm ~/.agent-peers.db`. Phase 2 may add a TTL if accumulation becomes measurable.

**Resolved:**
- Codex MCP config format → confirmed `[mcp_servers.NAME]` TOML block via inspection of user's existing config.toml
- Broker port → 7900
- Naming → `agent-peers` (MCP), `agentpeers` (alias), `agent-peers-mcp` (folder/repo)

---

## 12. Change log

- 2026-04-13 — Initial spec written. Phase 1 scope locked. Approved by user.
- 2026-04-13 — Added §5.7 Identity & naming system. Immutable UUID `id` + mutable `name` column, auto-generated adjective-noun names, `PEER_NAME` env override, terminal tab title via OSC escape, `rename_peer` tool, `send_message` accepts name or id. Motivated by user's PR-workflow need for stable human-readable handles across sessions.
- 2026-04-14 — Incorporated Codex adversarial review round 7 findings:
  - [critical] Task 18's cleanup snippet was updated to add `clearInterval(pushTimer)` but also reintroduced `client.unregister(myId)` that Task 17 had removed → removed the unregister from the Task 18 snippet with an explicit "NO unregister here" comment. The cleanup path now stays consistent across both tasks.
  - [medium] §9 error table row for "client polled a message but crashed before ack" said recipient dedupes via seen-set — true only within a session. Added explicit note that post-restart replay is at-least-once behavior per §5.4.
  - [medium] Task 25 didn't prove replay-on-restart behavior. Added manual Step 3 that sends a message, polls it into the inbox, SIGKILLs the receiver, restarts with same `PEER_NAME`, and asserts the same `message_id` is injected again.

- 2026-04-14 — Incorporated Codex adversarial review round 6 findings:
  - [critical] `gcStalePeers` had SELECT-then-iterate-DELETE → race with reclaim could delete a just-refreshed peer → replaced with single-statement `DELETE FROM peers WHERE last_seen < ?`. Added `gcStalePeers does NOT delete a peer whose last_seen was refreshed` regression test.
  - [high] Duplicate delivery across restart with reclaimed UUID — seen-set is in-memory so replay is possible after reclaim. Explicitly **downgraded spec contract to at-least-once across restart boundaries** with a §5.4/§5.5 note. Exactly-once across restart would require persistent dedupe state; deferred to Phase 2.
  - [high] Pre-`mcp.connect()` failure left a live peer row that blocked same-name reclaim for 60s → added `main().catch(async e => { if (myId) await client.unregister(myId); })` in both servers so startup failures clean up their row. Post-connect failures still use the signal-handler path that deliberately preserves the row for reclaim.
  - [medium] §5.5 said "we unregister the peer" on clean shutdown, contradicting §5.1 "cleanup does NOT call /unregister" → rewrote §5.5 to match: no unregister on graceful exit, GC reaps within 60-90s, reclaim preserves UUID if restart happens in that window.

- 2026-04-13 — Incorporated Codex adversarial review round 5 findings:
  - [high] Graceful shutdown was calling `client.unregister()`, which deleted the peer row immediately and made messages addressed to the old UUID permanently unrecoverable. Added **reclaim-by-name** to `/register`: if `PEER_NAME` matches an existing stale peer (last_seen > 60s old), `UPDATE` that row in place and reuse its UUID, so undelivered messages route correctly to the restarted session. Removed `client.unregister()` from both server cleanup paths so the broker GC handles peer removal naturally on the 60-90s window.
  - [medium] Spec test/non-goals sections still treated `check_messages` as the load-bearing Codex delivery trigger → rewrote test scenarios 5-8 to reference "any tool call" and removed the obsolete TTL line that mentioned `check_messages` as the gating action.
  - [low] Task 19 module comment still claimed "next call = proof of delivery" → softened to "strong heuristic, not proof", with explicit pointer to spec §5.5 residual-limitations.

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
