# Wake daemon — operations & logging

The wake daemon is the background loop that lets idle, app-server-backed Codex
peers be *woken* when another peer sends them a message. Each launch
(`codex-peer` or `codex-peer start …`) auto-starts it; you can
also run it in the foreground with `peerwake` (`codex-peer daemon`).

- **Engine:** `shared/wake-daemon.ts` (`runWakePass`) — one bodyless pass.
- **Entry:** `wake-daemon.ts` — prints one line per noteworthy result.
- **Loop:** `bin/codex-peer` `run_daemon` runs the entry every
  `CODEX_PEER_DAEMON_INTERVAL` seconds (default 5).
- **Log:** `~/.agent-peers-codex/wake-daemon.log`.
- **State:** `~/.agent-peers-codex/wake-ledger/` (wake backoff per unread set),
  `~/.agent-peers-codex/wake-observe/` (per-peer skip-state, for log coalescing).

## How a pass decides

For each registered peer with unread messages, a pass reads the peer's live
thread status from its app-server and acts on it:

| Thread state | What the daemon does |
|---|---|
| `idle` | Eligible to wake. A per-peer 30-second budget coalesces newly arriving mail; the **wake ledger** fires one nudge, then backs off re-waking the *same* unread set on a `5m → 30m → 2h` schedule and abandons after the cap. |
| `active` / `waitingOnApproval` / `waitingOnUserInput` | Peer's user is mid-turn — **not** woken. Polled every pass so delivery happens the instant it goes idle; the repeated log lines are coalesced. |
| `systemError` | Thread is **wedged** (a failed/crashed turn). It can't be woken until bounced. Re-checked on an escalating `5m → 30m → 2h` backoff instead of every pass, and logged once with a bounce hint. |

## Reading the log

Lines are timestamped (UTC ISO-8601):

```
2026-06-22T21:15:03.124Z wake: nudged api-codex (79eea704…) thread=019ee815…
2026-06-22T21:20:40.880Z wake: skipped web-codex (4a12af35…) thread=019ee81d… (thread_system_error) — close the TUI and relaunch `codex-peer` in ~/code/web-app
```

The daemon **coalesces** repeated skips: a state is logged once when it starts
(a transition) and then at most once per heartbeat window (escalating for a
wedged peer) until it changes — so a stuck or busy peer costs a handful of lines
a day, not thousands. A `wake: nudged` line always prints.

### "peer thread hit a system error … bounce it"

This peer's Codex thread is in `systemError`. The daemon will keep it on a slow
re-check (so it auto-recovers if the thread heals) but cannot wake it. To clear
it: close that peer's TUI and relaunch it (`codexpeer` in the printed `cwd`).
`codexpeer live` shows current peer state.

## Tuning (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_PEER_DAEMON_INTERVAL` | `5` | Seconds between passes. |
| `CODEX_PEER_MIN_WAKE_INTERVAL_MS` | `30000` | Minimum milliseconds between model-starting wakes for one peer, even when new messages change the unread signature. |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` | `5242880` (5 MiB) | Live log is copy-truncated to `wake-daemon.log.1`, `.2`, … once it reaches this size. |
| `CODEX_PEER_DAEMON_LOG_KEEP` | `3` | Number of rotated log files to keep. |
| `AGENT_PEERS_CODEX_STATE_DIR` | `~/.agent-peers-codex` | Root for the log, registry, and daemon state. |

Rotation is copy-truncate (not rename) because the backgrounded daemon holds the
log file descriptor open in append mode for its whole life; truncating in place
lets it keep writing without a restart. Picking up a **changed rotation cap or
interval** does require restarting the daemon (`codex-peer daemon-stop`, then any
launch re-starts it); the wake *logic* is reloaded every pass automatically.
