// Durable, bounded, crash-safe inbox used by the Codex MCP adapter.

import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { MAX_ID_CHARS, MAX_MESSAGE_BYTES, MAX_PATH_CHARS, MAX_SUMMARY_CHARS, utf8ByteLength } from "./limits.ts";
import type { LeasedMessage, PeerId } from "./types.ts";
import { createLogger } from "./logger.ts";

const inboxLog = createLogger("durable-inbox");

interface CodexInboxState {
  version: 1;
  unread: LeasedMessage[];
}

// Bodyless sidecar consumed by the wake daemon. Keep this deliberately minimal:
// the daemon needs only message identity, recipient identity, and arrival time.
export interface CodexInboxMessageMetadata {
  id: number;
  to_id: string;
  sent_at: string;
}

export interface CodexInboxMetadataState {
  unread: CodexInboxMessageMetadata[];
  updated_at: string;
}

const EMPTY_STATE: CodexInboxState = { version: 1, unread: [] };
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IS_POSIX = platform() !== "win32";
const MAX_INBOX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_INBOX_MESSAGES = 1_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

function processStartIdentity(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.toString().trim();
    return value || null;
  } catch {
    return null;
  }
}

function cloneMessages(messages: LeasedMessage[]): LeasedMessage[] {
  return messages.map((message) => ({ ...message }));
}

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

async function ensureSafeDirectory(dir: string): Promise<void> {
  try {
    const before = await lstat(dir);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`inbox state directory is a symlink or not a directory: ${dir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
  const after = await lstat(dir);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error(`inbox state directory is a symlink or not a directory: ${dir}`);
  }
  if (IS_POSIX) {
    const mine = (process as unknown as { getuid?: () => number }).getuid?.();
    if (typeof mine === "number" && after.uid !== mine) {
      throw new Error(`inbox state directory is not owned by the current user: ${dir}`);
    }
    await chmod(dir, DIR_MODE);
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await ensureSafeDirectory(dir);
  const serialized = JSON.stringify(value, null, 2);
  if (utf8ByteLength(serialized) > MAX_INBOX_FILE_BYTES) {
    throw new Error("inbox state is too large");
  }
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const noFollow = IS_POSIX ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    FILE_MODE,
  );
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (IS_POSIX) await chmod(tempPath, FILE_MODE);
  try {
    await rename(tempPath, path);
    try {
      const dirHandle = await open(dir, fsConstants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch { /* some filesystems do not support directory fsync */ }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function validString(value: unknown, maxChars: number, allowEmpty = true): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maxChars;
}

function isLeasedMessage(value: unknown): value is LeasedMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Partial<LeasedMessage>;
  return Number.isSafeInteger(m.id) && (m.id ?? 0) > 0
    && validString(m.from_id, MAX_ID_CHARS, false)
    && validString(m.from_name, 32, false)
    && (m.from_peer_type === "claude" || m.from_peer_type === "codex")
    && validString(m.from_cwd, MAX_PATH_CHARS)
    && validString(m.from_summary, MAX_SUMMARY_CHARS)
    && validString(m.to_id, MAX_ID_CHARS, false)
    && validString(m.text, MAX_MESSAGE_BYTES, false)
    && utf8ByteLength(m.text!) <= MAX_MESSAGE_BYTES
    && validString(m.sent_at, 64, false)
    && Number.isFinite(Date.parse(m.sent_at!))
    && validString(m.lease_token, MAX_ID_CHARS, false);
}

function parseState(raw: string): CodexInboxState {
  const parsed = JSON.parse(raw) as { version?: unknown; unread?: unknown };
  if (parsed.version !== undefined && parsed.version !== 1) throw new Error("unsupported inbox version");
  if (!Array.isArray(parsed.unread)) throw new Error("inbox unread must be an array");
  if (parsed.unread.length > MAX_INBOX_MESSAGES) throw new Error("too many inbox messages");
  if (!parsed.unread.every(isLeasedMessage)) throw new Error("invalid inbox message schema");
  return { version: 1, unread: cloneMessages(parsed.unread) };
}

export class CodexInboxStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly metadataFilePath: string;
  private readonly persistState: (path: string, value: CodexInboxState) => Promise<void>;
  private readonly persistMetadata: (path: string, value: CodexInboxMetadataState) => Promise<void>;
  private readonly onMetadataError: (error: unknown) => void;
  private state: CodexInboxState = { ...EMPTY_STATE, unread: [] };
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: {
    peerId: PeerId;
    rootDir?: string;
    persistState?: (path: string, value: CodexInboxState) => Promise<void>;
    persistMetadata?: (path: string, value: CodexInboxMetadataState) => Promise<void>;
    onMetadataError?: (error: unknown) => void;
  }) {
    const rootDir = opts.rootDir ?? process.env.AGENT_PEERS_CODEX_STATE_DIR ?? defaultRootDir();
    const safePeerId = encodeURIComponent(opts.peerId);
    this.filePath = join(rootDir, `${safePeerId}.json`);
    this.lockPath = `${this.filePath}.lock`;
    this.metadataFilePath = join(rootDir, `${safePeerId}.metadata.json`);
    this.persistState = opts.persistState ?? atomicWriteJson;
    this.persistMetadata = opts.persistMetadata ?? atomicWriteJson;
    this.onMetadataError = opts.onMetadataError ?? (() => {
      inboxLog.warn("metadata_write_failed");
    });
  }

  async init(): Promise<void> {
    await this.withLock(async () => {
      await this.withFileLock(async () => {
        this.state = await this.readStateFromDisk();
        // Repair a missing or stale sidecar after upgrades or a previous
        // best-effort metadata failure without changing the authoritative inbox.
        await this.persistMetadataBestEffort(this.state);
      });
    });
  }

  async getUnreadMessages(): Promise<LeasedMessage[]> {
    return this.withLock(async () => cloneMessages(this.state.unread));
  }

  async getUnreadMessageMetadata(): Promise<CodexInboxMessageMetadata[]> {
    return this.withLock(async () => metadataForMessages(this.state.unread));
  }

  async queueLeasedMessages(messages: LeasedMessage[]): Promise<void> {
    if (!messages.every(isLeasedMessage)) throw new Error("invalid leased message");
    await this.mutate(async (current) => {
      const unreadById = new Map(current.unread.map((message) => [message.id, { ...message }]));
      for (const message of messages) unreadById.set(message.id, { ...message });
      if (unreadById.size > MAX_INBOX_MESSAGES) throw new Error("too many unread inbox messages");
      return { version: 1, unread: Array.from(unreadById.values()).sort((a, b) => a.id - b.id) };
    });
  }

  async consumeUnreadMessages(): Promise<LeasedMessage[]> {
    let unread: LeasedMessage[] = [];
    await this.mutate(async (current) => {
      unread = cloneMessages(current.unread);
      return { ...EMPTY_STATE, unread: [] };
    });
    return unread;
  }

  async removeByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutate(async (current) => {
      const drop = new Set(ids);
      return { version: 1, unread: current.unread.filter((m) => !drop.has(m.id)) };
    });
  }

  async reset(): Promise<void> {
    await this.mutate(async () => ({ ...EMPTY_STATE, unread: [] }));
  }

  private async mutate(fn: (current: CodexInboxState) => Promise<CodexInboxState>): Promise<void> {
    await this.withLock(async () => {
      await this.withFileLock(async () => {
        // Refresh inside the process-wide lock so concurrent writers merge
        // against the latest durable state rather than stale memory.
        const current = await this.readStateFromDisk();
        const next = await fn(current);
        await this.persistState(this.filePath, next);
        this.state = next;
        await this.persistMetadataBestEffort(next);
      });
    });
  }

  private async persistMetadataBestEffort(state: CodexInboxState): Promise<void> {
    try {
      await this.persistMetadata(this.metadataFilePath, {
        unread: metadataForMessages(state.unread),
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      this.onMetadataError(error);
    }
  }

  private async readStateFromDisk(): Promise<CodexInboxState> {
    let fileStat;
    try {
      fileStat = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE, unread: [] };
      throw error;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`inbox path is a symlink or not a regular file: ${this.filePath}`);
    }
    if (fileStat.nlink !== 1) {
      throw new Error(`inbox file has ${fileStat.nlink} hard links; expected exactly one link`);
    }
    if (IS_POSIX) {
      const mine = (process as unknown as { getuid?: () => number }).getuid?.();
      if (typeof mine === "number" && fileStat.uid !== mine) {
        throw new Error(`inbox file is not owned by the current user: ${this.filePath}`);
      }
      if ((fileStat.mode & 0o777) !== FILE_MODE) {
        inboxLog.error("insecure_file_mode");
        throw new Error("insecure inbox file mode");
      }
    }
    if (fileStat.size > MAX_INBOX_FILE_BYTES) return this.quarantine("file too large");
    try {
      return parseState(await readFile(this.filePath, "utf8"));
    } catch (error) {
      return this.quarantine(error instanceof Error ? error.message : "corrupt state");
    }
  }

  private async quarantine(reason: string): Promise<CodexInboxState> {
    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    await rename(this.filePath, quarantinePath);
    inboxLog.warn("state_quarantined", { reason });
    return { ...EMPTY_STATE, unread: [] };
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureSafeDirectory(dirname(this.filePath));
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle;
    while (!handle) {
      try {
        handle = await open(this.lockPath, "wx", FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await lstat(this.lockPath);
          let ownerAlive = false;
          try {
            const parsed = JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: unknown; process_start?: unknown };
            if (Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0) {
              try { process.kill(parsed.pid as number, 0); ownerAlive = true; }
              catch (probe) { ownerAlive = (probe as NodeJS.ErrnoException).code === "EPERM"; }
              if (ownerAlive && typeof parsed.process_start === "string") {
                const currentStart = processStartIdentity(parsed.pid as number);
                // A live process with the same PID but a different start time
                // is a PID-reuse collision, not the lock owner.
                if (currentStart !== null && currentStart !== parsed.process_start) ownerAlive = false;
              }
              if (!ownerAlive) await rm(this.lockPath, { force: true });
            } else if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
              await rm(this.lockPath, { force: true });
            }
          } catch {
            if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) await rm(this.lockPath, { force: true });
          }
        } catch { /* lock disappeared; retry */ }
        if (Date.now() >= deadline) throw new Error("timed out waiting for inbox file lock");
        await Bun.sleep(10);
      }
      if (handle) {
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            process_start: processStartIdentity(process.pid),
            created_at: Date.now(),
          }), "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close();
          await rm(this.lockPath, { force: true });
          throw error;
        }
      }
    }
    const ownedStat = await handle.stat();
    try {
      return await fn();
    } finally {
      await handle.close();
      try {
        const current = await lstat(this.lockPath);
        if (current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
          await rm(this.lockPath, { force: true });
        }
      } catch { /* lock was already removed or replaced */ }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

function metadataForMessages(messages: LeasedMessage[]): CodexInboxMessageMetadata[] {
  return messages.map((message) => ({
    id: message.id,
    to_id: message.to_id,
    sent_at: message.sent_at,
  }));
}

export { EMPTY_STATE as EMPTY_CODEX_INBOX_STATE, MAX_INBOX_MESSAGES };
