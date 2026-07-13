import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import type { PeerName, PeerType } from "./types.ts";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IS_POSIX = platform() !== "win32";

export interface StoredPeerIdentity {
  name: PeerName;
  reclaim_token: string;
}

function rootDir(): string {
  return process.env.AGENT_PEERS_IDENTITY_DIR ?? join(homedir(), ".agent-peers-identities");
}

function identityPath(peerType: PeerType, requestedName: PeerName, overrideRoot?: string): string {
  return join(overrideRoot ?? rootDir(), `${peerType}-${encodeURIComponent(requestedName)}.json`);
}

async function ensureSafeDirectory(dir: string): Promise<void> {
  try {
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("peer identity directory is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("peer identity directory is unsafe");
  if (IS_POSIX) {
    const uid = (process as unknown as { getuid?: () => number }).getuid?.();
    if (typeof uid === "number" && stat.uid !== uid) throw new Error("peer identity directory has another owner");
    await chmod(dir, DIR_MODE);
  }
}

export async function loadPeerIdentity(
  peerType: PeerType,
  requestedName: PeerName | undefined,
  overrideRoot?: string,
): Promise<StoredPeerIdentity | null> {
  if (!requestedName) return null;
  const path = identityPath(peerType, requestedName, overrideRoot);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("peer identity file is unsafe");
    if (IS_POSIX) {
      const uid = (process as unknown as { getuid?: () => number }).getuid?.();
      if (typeof uid === "number" && stat.uid !== uid) throw new Error("peer identity file has another owner");
      if ((stat.mode & 0o777) !== FILE_MODE) throw new Error("peer identity file mode is insecure");
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredPeerIdentity>;
    if (typeof parsed.name !== "string" || typeof parsed.reclaim_token !== "string"
      || parsed.name.length === 0 || parsed.reclaim_token.length < 32) {
      throw new Error("peer identity file is invalid");
    }
    return { name: parsed.name, reclaim_token: parsed.reclaim_token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function savePeerIdentity(
  peerType: PeerType,
  requestedName: PeerName | undefined,
  identity: StoredPeerIdentity,
  overrideRoot?: string,
  expectedReclaimToken: string | null = null,
): Promise<boolean> {
  if (!requestedName) return false;
  const path = identityPath(peerType, requestedName, overrideRoot);
  const dir = dirname(path);
  await ensureSafeDirectory(dir);
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const noFollow = IS_POSIX ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(identity), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (expectedReclaimToken === null) {
      // Atomic create-if-absent: concurrent sessions with the same requested
      // name cannot overwrite whichever durable identity won first.
      try {
        await link(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      } finally {
        await rm(temp, { force: true });
      }
    } else {
      const current = await loadPeerIdentity(peerType, requestedName, overrideRoot);
      if (!current || current.reclaim_token !== expectedReclaimToken
        || identity.reclaim_token !== expectedReclaimToken) {
        await rm(temp, { force: true });
        return false;
      }
      await rename(temp, path);
    }
    if (IS_POSIX) await chmod(path, FILE_MODE);
    return true;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
