import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("installed codex-peer symlink resolves assets from the real repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-installed-"));
  try {
    const command = join(dir, "codex-peer");
    const fakeOpen = join(dir, "open");
    await symlink(join(process.cwd(), "bin", "codex-peer"), command);
    await writeFile(fakeOpen, "#!/bin/sh\nprintf '%s\\n' \"$1\"\n", "utf8");
    await chmod(fakeOpen, 0o755);
    const proc = Bun.spawn([command, "doc"], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(error).toBe("");
    expect(output.trim()).toBe(join(process.cwd(), "docs", "examples", "wakeable-codex-peer-demo.html"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wake daemon rejects a zero-second busy loop", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-peers-daemon-"));
  try {
    const proc = Bun.spawn(["bash", "bin/codex-peer", "daemon", "0"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_PEERS_CODEX_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(error).toMatch(/at least one second/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
