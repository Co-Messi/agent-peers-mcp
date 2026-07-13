#!/usr/bin/env bun
// wake-daemon.ts
// One-shot wake pass for app-server-backed Codex sessions.

import { runWakePass } from "./shared/wake-daemon.ts";
import { sanitizeTerminalText as safe } from "./shared/safe-output.ts";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const quietNoop = args.has("--quiet-noop");
const results = await runWakePass();
for (const result of results) {
  if (json) {
    console.log(JSON.stringify(result));
    continue;
  }
  // Daemon mode (--quiet-noop) honors the observation log: only transitions and
  // heartbeats print, so a wedged/busy peer no longer floods the log. The manual
  // `wake` command stays verbose (prints every result) for on-demand debugging.
  if (quietNoop && !result.log) continue;

  const ts = new Date().toISOString();
  const target = `${safe(result.peer_name, 32)} (${safe(result.peer_id.slice(0, 8), 8)}…) thread=${safe(result.thread_id, 128)}`;
  const note = result.note ? ` — ${safe(result.note, 1024)}` : "";
  if (result.action === "wake") {
    console.log(`${ts} wake: nudged ${target}${note}`);
  } else {
    console.log(`${ts} wake: skipped ${target} (${safe(result.reason, 64)})${note}`);
  }
}
if (!json && !quietNoop && results.length === 0) {
  console.log(`${new Date().toISOString()} wake: no wakeable Codex sessions registered`);
}
