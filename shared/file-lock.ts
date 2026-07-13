import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";

const LOCK_MODE = 0o600;

function processStartIdentity(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withInterprocessFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, LOCK_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await lstat(lockPath);
        const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown; process_start?: unknown };
        const pid = Number.isSafeInteger(parsed.pid) ? parsed.pid as number : 0;
        let ownerAlive = pid > 0 && processAlive(pid);
        if (ownerAlive && typeof parsed.process_start === "string") {
          const current = processStartIdentity(pid);
          if (current !== null && current !== parsed.process_start) ownerAlive = false;
        }
        if (!ownerAlive || Date.now() - stat.mtimeMs > staleMs) await rm(lockPath, { force: true });
      } catch {
        // A malformed lock is only removable after the stale window; this
        // avoids stealing a just-created lock before its owner writes metadata.
        try {
          const stat = await lstat(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) await rm(lockPath, { force: true });
        } catch { /* lock disappeared */ }
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock: ${lockPath}`);
      await Bun.sleep(10);
    }
  }

  try {
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      process_start: processStartIdentity(process.pid),
      created_at: Date.now(),
    }), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  const owned = await handle.stat();
  try {
    return await fn();
  } finally {
    await handle.close();
    try {
      const current = await lstat(lockPath);
      if (current.dev === owned.dev && current.ino === owned.ino) await rm(lockPath, { force: true });
    } catch { /* removed or replaced */ }
  }
}
