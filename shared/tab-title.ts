// shared/tab-title.ts
// Best-effort terminal tab title updater via OSC escape sequences.
// Never throws — cosmetic affordance must not crash the MCP server.
//
// Keepalive model (round 2):
//   Modern terminals (iTerm2, Terminal.app, Warp, Ghostty, …) track the
//   currently-running foreground process and periodically overwrite the
//   tab title with the binary name ("node" / "bun"). Writing OSC once at
//   startup therefore decays: the shell-side process tracker beats us.
//   We re-assert every KEEPALIVE_INTERVAL_MS.
//
//   Round-2 tightening (based on live-session report that tab still
//   reverted to "node"):
//     1. Interval dropped from 3s → 1s so the worst-case "node" window
//        is ≤1s instead of ≤3s.
//     2. We write ALL THREE relevant OSCs every tick, not just OSC 0:
//          OSC 0 → icon name + window title (legacy)
//          OSC 1 → icon name ONLY (iTerm2 + many Linux terms use this
//                  for tab titles specifically)
//          OSC 2 → window title ONLY
//        Some terminals honor one but not the others, and iTerm2 in
//        particular treats OSC 1 as the "tab title" source. Writing all
//        three covers the spread.
//     3. Keepalive is started by the MCP server MAIN before register()
//        runs, so the tab title is set before any other startup
//        activity. Pre-register we don't know our peer name yet, so we
//        write a placeholder ("peer:starting") that the post-register
//        setTabTitle() overwrites.
//
// Even with these, a terminal configured to FORCE a specific title
// source (e.g. iTerm2 "Profile → General → Title: Process Name" with
// no application override) will still win. The user can set
// AGENT_PEERS_DISABLE_TAB_TITLE=1 to opt out.

import { openSync, writeSync, closeSync } from "node:fs";

const KEEPALIVE_INTERVAL_MS = 1_000;

let lastTitle: string | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let keepaliveWarned = false;

function writeAllOscs(fd: number, title: string): void {
  // OSC 0: icon name + window title.
  writeSync(fd, `\x1b]0;${title}\x07`);
  // OSC 1: icon name (tab title on iTerm2 and most *nix terms).
  writeSync(fd, `\x1b]1;${title}\x07`);
  // OSC 2: window title explicitly.
  writeSync(fd, `\x1b]2;${title}\x07`);
}

function writeTitle(title: string): void {
  if (process.env.AGENT_PEERS_DISABLE_TAB_TITLE === "1") return;

  // Strip control chars so we can't accidentally inject other escape sequences.
  const safe = title.replace(/[\x00-\x1f\x7f]/g, "");

  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeAllOscs(fd, safe);
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

export function setTabTitle(title: string): void {
  lastTitle = title;
  keepaliveWarned = false; // new title — reset warn gate
  writeTitle(title);
}

// Start the re-assert loop. Safe to call multiple times (idempotent — any
// existing timer is cleared first). Can be called BEFORE the first
// setTabTitle() — in that case the timer just no-ops until setTabTitle
// sets `lastTitle`.
export function startTabTitleKeepalive(): void {
  if (process.env.AGENT_PEERS_DISABLE_TAB_TITLE === "1") return;
  stopTabTitleKeepalive();
  keepaliveTimer = setInterval(() => {
    if (lastTitle !== null) writeTitle(lastTitle);
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
      writeAllOscs(fd, "");
    } finally {
      closeSync(fd);
    }
  } catch {
    // swallow — we're already exiting
  }
}
