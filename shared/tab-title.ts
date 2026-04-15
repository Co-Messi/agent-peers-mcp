// shared/tab-title.ts
// Best-effort terminal tab title updater via OSC 0 escape.
// Never throws — cosmetic affordance must not crash the MCP server.
//
// Keepalive model (added to fix the "title reverts to `node` after a
// while" bug):
//   Modern terminals (iTerm2, Terminal.app, Warp, Ghostty, …) track the
//   currently-running foreground process and periodically overwrite the
//   tab title with the binary name ("node", "bun", etc.). Writing OSC 0
//   once at startup therefore decays: the shell-side process tracker
//   beats us. The fix is to periodically re-assert via startKeepalive —
//   the write is ~30 bytes to /dev/tty every few seconds, cheap enough
//   to be invisible. Re-asserts whatever the last explicit setTabTitle
//   was (captured via `lastTitle`), so `rename_peer` also stays sticky.

import { openSync, writeSync, closeSync } from "node:fs";

const KEEPALIVE_INTERVAL_MS = 3_000;

let lastTitle: string | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function writeOsc0(title: string): void {
  if (process.env.AGENT_PEERS_DISABLE_TAB_TITLE === "1") return;

  // Strip control chars so we can't accidentally inject other escape sequences.
  const safe = title.replace(/[\x00-\x1f\x7f]/g, "");

  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, `\x1b]0;${safe}\x07`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // No controlling TTY, permission denied, closed pty, etc. — non-fatal.
    // Only log the FIRST failure so the keepalive doesn't spam stderr
    // every tick if something's wrong (e.g. user closed the tab).
    if (!keepaliveWarned) {
      console.error(
        `[agent-peers] tab title write failed (non-fatal, will stop warning): ${e instanceof Error ? e.message : String(e)}`,
      );
      keepaliveWarned = true;
    }
  }
}
let keepaliveWarned = false;

export function setTabTitle(title: string): void {
  lastTitle = title;
  keepaliveWarned = false; // new title — reset warn gate
  writeOsc0(title);
}

// Start the re-assert loop. Safe to call multiple times (idempotent — any
// existing timer is cleared first). Must be called AFTER the first
// setTabTitle so `lastTitle` is populated; otherwise a no-op.
export function startTabTitleKeepalive(): void {
  if (process.env.AGENT_PEERS_DISABLE_TAB_TITLE === "1") return;
  stopTabTitleKeepalive();
  keepaliveTimer = setInterval(() => {
    if (lastTitle !== null) writeOsc0(lastTitle);
  }, KEEPALIVE_INTERVAL_MS);
  // Do not hold the event loop open just for the title keepalive — the
  // MCP server's other timers (heartbeat, poll loop) are the real reason
  // the process stays alive. If those exit, we don't want the title
  // keepalive to be the last holdout.
  if (typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();
}

export function stopTabTitleKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// Clear the terminal title back to the shell's default. Called on MCP cleanup
// so a lingering `peer:calm-fox` title doesn't outlive the session.
export function clearTabTitle(): void {
  stopTabTitleKeepalive();
  lastTitle = null;
  setTabTitle("");
}

// Synchronous variant safe to call from process.on("exit", ...). Writes directly
// without spawning async work. Used as a last-resort fallback when SIGHUP or
// unexpected termination paths prevent the normal async cleanup from running.
export function clearTabTitleSync(): void {
  stopTabTitleKeepalive();
  lastTitle = null;
  if (process.env.AGENT_PEERS_DISABLE_TAB_TITLE === "1") return;
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, `\x1b]0;\x07`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // swallow — we're already exiting
  }
}
