# Wakeable Codex peers (idle wake, no fork)

This document describes how `agent-peers-mcp` makes an **idle** Codex CLI session
respond to peer messages **without forking the Codex binary**, the security model
that keeps it safe, and its failure modes.

## The problem

Stock Codex CLI only surfaces peer messages **on the response of an agent-peers
tool call**. An idle Codex — parked at its prompt, calling no tools — never sees
queued messages until it does something on its own (your next user turn, or any
agent-peers tool call). Unlike Claude Code, Codex exposes no MCP push channel an
external process can use to trigger a turn ([OpenAI Codex docs list `tools` as the
only supported MCP feature](https://github.com/openai/codex/blob/main/docs/config.md)).

The previously proposed fix was to **fork the Codex binary** and patch it to
surface `notifications/message` as developer instructions — which means tracking a
moving Rust codebase and rebuilding on every Codex release. Wakeable mode avoids
that entirely.

## Design: app-server-backed wake, no fork

Codex ships an **app-server** mode (`codex app-server --listen ws://…`) that hosts
a thread over local WebSocket JSON-RPC and lets a client start turns on it, while a
visible `codex resume --remote <url> <thread>` TUI stays attached to the *same*
thread. Wakeable mode uses that to make wakeability a **launch-time property**:

1. Start Codex under a managed app-server bound to one thread.
2. Register `peer_id -> { app_server_url, thread_id, … }` in a durable wake registry.
3. A small daemon watches for unread mail and, when the target thread is **loaded
   and idle**, sends a **bodyless** wake prompt into that same thread — which makes
   Codex call `check_messages` and surface the real content through the normal
   tool-response path.

The woken session is the **same live instance**: same thread, same rollout file,
same visible TUI. It is never killed or restarted with fresh context.

## Components

| File | Role |
|---|---|
| `bin/codex-peer` | Operator CLI: launch wakeable peers, manage the background daemon, inspect/repair/retire |
| `wakeable-codex.ts` → `shared/wakeable-launcher.ts` | Start the app-server, start/resume the thread, launch the visible TUI, write a launch claim |
| `shared/app-server-client.ts` | Minimal Codex app-server JSON-RPC client (`thread/loaded/list`, `thread/read`, `turn/start`) with bounded connect/request timeouts |
| `shared/wake-registry.ts` | Durable `peer_id -> app-server/thread` registry (0o600), liveness checks, GC of dead rows |
| `shared/wake-launch-claims.ts` | Launcher ↔ MCP-child handshake so the visible session's `peer_id` is bound to the right app-server/thread |
| `shared/codex-inbox.ts` | Durable on-disk inbox **plus bodyless metadata** the daemon reads |
| `shared/wake-daemon.ts` → `wake-daemon.ts` | The wake engine: one pass over the registry + metadata, with backoff/cap + GC |
| `codex-server.ts` | Registers the wakeable session and writes bodyless metadata when mail arrives |

## The wake turn

The wake prompt is deliberately **bodyless**:

```
[agent-peers wake]
You have pending agent-peers messages in your local MCP inbox. Immediately call
the agent-peers check_messages tool once. Treat that tool response as the only
authoritative message content. Do not infer message content from this wake
signal. After handling the inbox normally, return to waiting. Wake id: <uuid>
```

The daemon never carries the message body. `check_messages` (and its `[PEER INBOX]`
block) remains the single authoritative delivery path, exactly as for non-wakeable
Codex. The wake only causes a turn; it never *is* the message.

## Security model

- **Bodyless wake.** The daemon reads only the message id, recipient id, and
  timestamp — never sender metadata, the message body, or a lease
  token. The body lives only in the broker DB and is delivered only through
  `check_messages`.
- **Owner-only local state.** Inbox, metadata, registry, claim, and ledger files
  are written 0o600 inside a 0o700 directory. Security-sensitive inbox and
  registry reads validate type, owner, and mode; shared mutations are serialized
  with owner-only interprocess locks.
- **Loopback-only, same-user trust.** The app-server listens on `127.0.0.1`; the
  broker is local with a per-user 0o600 shared secret. This adds a loopback
  WebSocket but no non-loopback listener. It is not a hostile same-user sandbox:
  another process running as the same OS user remains inside the trust boundary.
- **Same-thread targeting is validated before every wake.** The daemon re-reads the
  thread and refuses to nudge unless `thread_id`, `cwd`, and (when known) the
  rollout path all match the registry, and the thread status is `idle`. Mismatches,
  `active`, `waitingOnApproval`, `waitingOnUserInput`, and error states are skipped
  — so a wake can never land on the wrong session or interrupt active/approval work.

## Token-cost characteristics

- **Idle with no mail = zero model tokens.** The idle TUI runs no inference. The
  wake daemon's poll is local-only (read metadata files + local WebSocket JSON-RPC
  to the app-server) and never calls the model. A model turn (`turn/start`) fires
  **only** when there is real unread mail for an idle thread.
- **Each wake re-bills the whole accumulated thread** as input tokens, because LLM
  turns are stateless and resend the full context; the prompt cache is cold after
  minutes. So per-wake cost grows with session age. This is inherent to the
  "same live instance" guarantee.
- **Wake cost is bounded per peer and per unread set.** New messages coalesce
  behind a 30-second per-peer minimum interval. Re-waking the same unread set
  also follows the longer backoff/cap below.

## Reliability & failure modes

- **Escalating backoff + attempt cap.** Re-waking the *same* unread set (e.g. the
  model checked then went idle, or ignored the nudge) backs off `5m → 30m → 2h` and
  is then **abandoned** — no more proactive nudges. The message is never lost; it
  still surfaces on the session's next tool call / user turn. This bounds the
  worst-case token cost of a stuck inbox to a handful of turns spread over hours,
  and removes the routine "one redundant wake" on the happy path. A new message
  bypasses the per-signature backoff but still respects the per-peer 30-second
  budget. An **active**
  (deeply-thinking) thread is skipped before the ledger is touched, so long turns
  never burn attempts and are never abandoned mid-thought.
- **Bounded app-server I/O.** Connect and every JSON-RPC request are timeout-bounded
  (5s default). A wedged or half-dead app-server fails fast (`app_server_unreachable`)
  so it can't stall the rest of the (sequential) wake pass.
- **Stale-state GC.** Each pass prunes dead wake-registry rows (past a grace window),
  dead/old launch-claim files, and old ledger files, so `~/.agent-peers-codex/`
  doesn't grow without bound. Live sessions are never pruned; inbox **message** files
  are never touched.
- **Ambiguity-safe repair.** Normal launches bind the visible session to its exact
  app-server/thread via env, so they are unambiguous. The `repair-wake` fallback,
  which matches by cwd/tty, **refuses** when two or more live distinct-thread
  sessions share a cwd/tty (e.g. two Codex in the same repo with no distinct TTY)
  rather than guessing and attaching to the wrong thread.
- **Confirm-on-next-call delivery.** Messages stay in the durable inbox until the
  *next* tool call proves the prior response reached the model, so a dropped wake
  response re-delivers instead of silently losing mail.

## Operating it

```bash
# install the helper onto PATH (one-time)
bun bin/codex-peer install

# launch a wakeable peer in the current repo (auto-name <repo>-codex)
codex-peer

# launch any repo with a stable name
codex-peer start my-service ~/code/my-service

# inspect / manage
codex-peer live              # wakeable sessions + unread counts
codex-peer daemon-status     # is the background daemon running?
codex-peer daemon-stop       # stop it
codex-peer repair-wake NAME  # re-attach a live peer whose wake pointer was lost
codex-peer retire NAME       # remove a stale/confusing peer from discovery
```

**The background wake daemon auto-starts on every launch** — idempotent,
single-instance (pidfile + atomic lock), detached via `nohup`/`disown` so it
survives the terminal closing and is brought back by the first launch after a
reboot. You can still run `codex-peer daemon` in the foreground if you prefer to
watch it; it refuses to double-start.

Relevant environment variables:

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PEERS_CODEX_STATE_DIR` | `~/.agent-peers-codex` | Inbox + wake registry/daemon state dir |
| `CODEX_PEER_DAEMON_INTERVAL` | `5` | Background daemon poll interval (seconds) |
| `CODEX_PEER_MIN_WAKE_INTERVAL_MS` | `30000` | Minimum time between model-starting wakes for one peer, across all unread signatures |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` | `5242880` | Size at which `wake-daemon.log` is rotated (copy-truncate) |
| `CODEX_PEER_DAEMON_LOG_KEEP` | `3` | Number of rotated wake-daemon logs to keep |

Day-to-day wake-daemon operations — log format, how repeated skips are coalesced,
the wedged-peer (`systemError`) backoff + bounce signal, and rotation — are
documented in [wake-daemon.md](wake-daemon.md).

The launcher also injects internal `AGENT_PEERS_WAKE_*` config into the app-server's
MCP child (app-server URL/pid, thread id, rollout path) so the visible session
registers itself against the exact thread it is attached to.

## Testing

The wake path is covered by focused tests:

- `tests/wake-daemon.test.ts` — idle nudge, identity/cwd/active guards, dup suppression, failed-wake leaves metadata intact
- `tests/wake-daemon-backoff.test.ts` — escalating backoff, re-wake on schedule, abandon at the cap
- `tests/wake-registry.test.ts` — persistence, dedupe, liveness filtering, perms, GC
- `tests/wake-launch-claims.test.ts` — claim matching, consumed-claim reuse, ambiguity surfacing, GC
- `tests/wakeable-launcher.test.ts` — arg/env/config construction (no secret leakage into env)
- `tests/app-server-client.test.ts` — connect/request timeouts
- `tests/codex-inbox-store.test.ts` — durable queue + bodyless metadata + fail-closed perms

Run `bunx tsc --noEmit` and `bun test` to verify.
