#!/usr/bin/env bun
// wake-daemon.ts
// One-shot wake pass for app-server-backed Codex sessions.

import { runWakePass } from "./shared/wake-daemon.ts";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const quietNoop = args.has("--quiet-noop");
const results = await runWakePass();
for (const result of results) {
  if (quietNoop && result.action === "skip" && result.reason === "no_pending_metadata") continue;
  if (json) {
    console.log(JSON.stringify(result));
    continue;
  }

  const target = `${result.peer_id.slice(0, 8)}… thread=${result.thread_id}`;
  if (result.action === "wake") {
    console.log(`wake: nudged ${target}`);
  } else {
    console.log(`wake: skipped ${target} (${result.reason})`);
  }
}
if (!json && !quietNoop && results.length === 0) {
  console.log("wake: no wakeable Codex sessions registered");
}
