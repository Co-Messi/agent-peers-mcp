// shared/peer-context.ts
// Best-effort process metadata for peer registration.

export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd, stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

export function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    if (tty && tty !== "?" && tty !== "??") return tty;
    return null;
  } catch {
    return null;
  }
}
