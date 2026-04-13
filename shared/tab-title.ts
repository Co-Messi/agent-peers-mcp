// shared/tab-title.ts
// Best-effort terminal tab title updater via OSC 0 escape.
// Never throws — cosmetic affordance must not crash the MCP server.

import { openSync, writeSync, closeSync } from "node:fs";

export function setTabTitle(title: string): void {
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
    console.error(
      `[agent-peers] tab title write failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
