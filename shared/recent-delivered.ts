// shared/recent-delivered.ts
// In-memory ring buffer of messages Claude's background poll loop has
// pushed via `notifications/claude/channel`. Exists because Claude Code's
// channel push only surfaces mid-turn: if the push fires while the
// session is idle at the prompt, Claude Code queues it and may not
// render it visibly until the next turn begins. Without a backfill,
// the user has no way to retrieve those messages (broker already acked).
//
// The ring buffer is the backfill. `recordDelivered(msg)` captures every
// successful channel push; `getRecentDelivered()` returns everything in
// the retention window so the `check_messages` tool can format it as a
// [PEER INBOX] block — same framing Codex uses.
//
// Retention: bounded by RECENT_MAX entries (oldest evicted) OR
// RECENT_TTL_MS wall-clock (older entries pruned on read/write),
// whichever is tighter. State is module-local in-memory — lost on
// process restart, which is fine because the colleague protocol treats
// each session as a fresh conversation anyway.
//
// Extracted out of claude-server.ts into this module specifically so
// the behavior is unit-testable without spawning a full MCP server.

import type { LeasedMessage } from "./types.ts";

interface RecentEntry {
  msg: LeasedMessage;
  delivered_at_ms: number;
}

export const RECENT_MAX = 50;
export const RECENT_TTL_MS = 15 * 60 * 1000; // 15 minutes

const recentDelivered: RecentEntry[] = [];

// Exposed for tests — lets a test advance a fake clock without mocking
// Date.now() globally. Production code never passes a `nowMs` arg.
function prune(nowMs: number = Date.now()): void {
  const cutoff = nowMs - RECENT_TTL_MS;
  while (recentDelivered.length > 0 && recentDelivered[0]!.delivered_at_ms < cutoff) {
    recentDelivered.shift();
  }
  while (recentDelivered.length > RECENT_MAX) {
    recentDelivered.shift();
  }
}

export function recordDelivered(msg: LeasedMessage, nowMs: number = Date.now()): void {
  recentDelivered.push({ msg, delivered_at_ms: nowMs });
  prune(nowMs);
}

export function getRecentDelivered(nowMs: number = Date.now()): LeasedMessage[] {
  prune(nowMs);
  return recentDelivered.map((e) => e.msg);
}

// Tests-only — drops the buffer entirely. Production code should never call this.
export function __resetRecentDeliveredForTest(): void {
  recentDelivered.length = 0;
}
