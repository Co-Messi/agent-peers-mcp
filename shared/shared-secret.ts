// shared/shared-secret.ts
// Read the per-user broker shared secret. The broker generates this on first
// startup into ~/.agent-peers-secret with file mode 0600; every client
// (cli.ts, MCP servers) reads it and passes it in the X-Agent-Peers-Secret
// header on every broker request. Without it, an arbitrary local process
// could enumerate peers or inject messages by just connecting to localhost.

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SECRET_PATH = resolve(homedir(), ".agent-peers-secret");

/**
 * Verify that the shared-secret file on disk is:
 *  - a regular file (not a symlink, not a device)
 *  - owned by the current OS user
 *  - mode 0600 (only owner can read/write) on POSIX systems
 *
 * If any check fails, throw a clear error. Fail-closed is intentional: a
 * mode-weakened file means another local user could have read it.
 *
 * Windows & other non-POSIX filesystems don't honor mode bits the same way,
 * so we skip the mode bit check there but still enforce regular-file + uid.
 */
function validateSecretFilePerms(path: string): void {
  // Use lstatSync-equivalent behavior by statSync — it follows symlinks,
  // but we want to reject symlinks specifically. Import lstatSync.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { lstatSync } = require("node:fs") as typeof import("node:fs");
  const lst = lstatSync(path);
  if (lst.isSymbolicLink()) {
    throw new Error(`shared secret at ${path} is a symlink — refusing (attacker could redirect to another user's file)`);
  }
  const st = statSync(path);
  if (!st.isFile()) {
    throw new Error(`shared secret at ${path} is not a regular file`);
  }
  // POSIX: stat.uid compared to process.getuid()
  if (typeof (process as unknown as { getuid?: () => number }).getuid === "function") {
    const mine = (process as unknown as { getuid: () => number }).getuid();
    if (st.uid !== mine) {
      throw new Error(`shared secret at ${path} is owned by uid ${st.uid}, not current user (${mine})`);
    }
    // mode & 0o777 must be 0o600 (only owner rw)
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`shared secret at ${path} has mode ${mode.toString(8)}, expected 0600 (other users can read it — refuse to use)`);
    }
  }
}

export function readSharedSecret(path: string = DEFAULT_SECRET_PATH): string | null {
  if (!existsSync(path)) return null;
  try {
    validateSecretFilePerms(path);
    const s = readFileSync(path, "utf8").trim();
    return s.length >= 32 ? s : null;
  } catch (e) {
    // Surface permission/ownership errors to stderr so the user sees them,
    // but don't crash the caller — they may have a degraded fallback path.
    console.error(`[agent-peers] shared secret validation failed: ${e instanceof Error ? e.message : String(e)}`);
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
