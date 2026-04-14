// shared/shared-secret.ts
// Read the per-user broker shared secret. The broker generates this on first
// startup into ~/.agent-peers-secret with file mode 0600; every client
// (cli.ts, MCP servers) reads it and passes it in the X-Agent-Peers-Secret
// header on every broker request. Without it, an arbitrary local process
// could enumerate peers or inject messages by just connecting to localhost.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SECRET_PATH = resolve(homedir(), ".agent-peers-secret");

export function readSharedSecret(path: string = DEFAULT_SECRET_PATH): string | null {
  if (!existsSync(path)) return null;
  try {
    const s = readFileSync(path, "utf8").trim();
    return s.length >= 32 ? s : null;
  } catch {
    return null;
  }
}

// Block until the broker has written the secret file. Used after ensureBroker
// spawns the broker daemon — the broker may take up to a few hundred ms to
// provision the secret, so clients poll briefly before giving up.
export async function waitForSharedSecret(
  path: string = DEFAULT_SECRET_PATH,
  timeoutMs = 6000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readSharedSecret(path);
    if (s) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `shared secret not found at ${path} after ${timeoutMs}ms — is the broker running and did it provision ~/.agent-peers-secret?`
  );
}
