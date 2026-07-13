#!/usr/bin/env bun
// wakeable-codex.ts
// Start a managed app-server-backed Codex TUI that agent-peers can wake.

import { parseWakeableLauncherArgs, runWakeableLauncher } from "./shared/wakeable-launcher.ts";

try {
  const opts = parseWakeableLauncherArgs(process.argv.slice(2));
  const code = await runWakeableLauncher(opts);
  process.exit(code);
} catch (error) {
  console.error(`wakeable-codex failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("usage: bun wakeable-codex.ts [--cwd DIR] [--port PORT] [--name PEER_NAME] [--alt-screen] [--materialize] [--no-materialize] [-- <codex-resume-extra-args>]");
  process.exit(2);
}
