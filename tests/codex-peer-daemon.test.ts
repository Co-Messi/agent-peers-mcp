import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("daemon-status rejects a stale pidfile whose PID was reused", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-peers-daemon-"));
  try {
    await writeFile(join(stateDir, "wake-daemon.pid"), `${process.pid}\n`, "utf8");
    const proc = Bun.spawn(["bash", "bin/codex-peer", "daemon-status"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_PEERS_CODEX_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(output).toContain("not running");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
