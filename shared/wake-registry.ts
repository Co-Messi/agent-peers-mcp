// shared/wake-registry.ts
// Durable registry for Codex sessions launched in wakeable app-server mode.

import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import type { PeerId, PeerName } from "./types.ts";
import { withInterprocessFileLock } from "./file-lock.ts";

export type WakeRegistryStatus = "starting" | "ready" | "stale";

export function hashBrokerSessionToken(sessionToken: string): string {
  return `sha256:${createHash("sha256").update(sessionToken, "utf8").digest("hex")}`;
}

export interface WakeRegistryEntry {
  peer_id: PeerId;
  peer_name: PeerName;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  thread_id: string;
  rollout_path: string | null;
  app_server_url: string;
  app_server_socket_path: string | null;
  app_server_pid: number;
  tui_pid: number | null;
  mcp_pid: number;
  broker_session_token_hash: string;
  status: WakeRegistryStatus;
  capabilities: string[];
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

interface WakeRegistryState {
  entries: WakeRegistryEntry[];
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IS_POSIX = platform() !== "win32";

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

async function atomicWriteJson<T>(path: string, value: T): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (IS_POSIX) {
    try { await chmod(dir, DIR_MODE); } catch { /* best effort */ }
  }

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
  if (IS_POSIX) {
    try { await chmod(tempPath, FILE_MODE); } catch { /* best effort */ }
  }
  await rename(tempPath, path);
}

function cloneEntry(entry: WakeRegistryEntry): WakeRegistryEntry {
  return {
    ...entry,
    capabilities: [...entry.capabilities],
  };
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function socketPathExists(path: string | null): Promise<boolean> {
  if (!path) return true;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class WakeRegistry {
  private readonly filePath: string;
  private readonly persistState: (path: string, value: WakeRegistryState) => Promise<void>;
  private state: WakeRegistryState = { entries: [] };
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: {
    rootDir?: string;
    persistState?: (path: string, value: WakeRegistryState) => Promise<void>;
  } = {}) {
    const rootDir = opts.rootDir ?? process.env.AGENT_PEERS_CODEX_STATE_DIR ?? defaultRootDir();
    this.filePath = join(rootDir, "wake-registry.json");
    this.persistState = opts.persistState ?? atomicWriteJson;
  }

  async init(): Promise<void> {
    await this.withLock(async () => {
      await this.ensureDir();
      this.state = await this.readStateFromDisk();
    });
  }

  async list(opts: { includeStale?: boolean } = {}): Promise<WakeRegistryEntry[]> {
    return this.withLock(async () => {
      this.state = await this.readStateFromDisk();
      const entries: WakeRegistryEntry[] = [];
      for (const entry of this.state.entries) {
        const live = await this.isLive(entry);
        if (opts.includeStale || live) entries.push(cloneEntry(live ? entry : { ...entry, status: "stale" }));
      }
      return entries.sort((a, b) => a.peer_name.localeCompare(b.peer_name) || a.thread_id.localeCompare(b.thread_id));
    });
  }

  async upsert(entry: WakeRegistryEntry): Promise<void> {
    await this.withLock(async () => {
      await this.withDiskLock(async () => {
        const current = await this.readStateFromDisk();
        const nextEntries = current.entries
          .filter((existing) => existing.peer_id !== entry.peer_id && existing.thread_id !== entry.thread_id)
          .map(cloneEntry);
        nextEntries.push(cloneEntry(entry));
        const nextState = { entries: nextEntries.sort((a, b) => a.peer_id.localeCompare(b.peer_id)) };
        await this.persistState(this.filePath, nextState);
        this.state = nextState;
      });
    });
  }

  async removeByPeerId(peerId: PeerId): Promise<void> {
    await this.withLock(async () => {
      await this.withDiskLock(async () => {
        const current = await this.readStateFromDisk();
        const nextState = { entries: current.entries.filter((entry) => entry.peer_id !== peerId) };
        if (nextState.entries.length === current.entries.length) {
          this.state = current;
          return;
        }
        await this.persistState(this.filePath, nextState);
        this.state = nextState;
      });
    });
  }

  // Garbage-collect entries whose processes are dead and that have not been
  // seen for longer than deadGraceMs. The grace window keeps a freshly-died
  // session visible in `peerstatus` for a short while (useful for diagnosis)
  // without letting dead rows accumulate forever. A live session is never
  // pruned regardless of age. Returns the number of rows removed.
  async prune(opts: { deadGraceMs: number; now?: () => Date } = { deadGraceMs: 30 * 60_000 }): Promise<number> {
    const nowMs = (opts.now ?? (() => new Date()))().getTime();
    return this.withLock(async () => {
      return this.withDiskLock(async () => {
        const current = await this.readStateFromDisk();
        const kept: WakeRegistryEntry[] = [];
        for (const entry of current.entries) {
          if (await this.isLive(entry)) {
            kept.push(entry);
            continue;
          }
          const lastSeen = Date.parse(entry.last_seen_at);
          const ageMs = Number.isFinite(lastSeen) ? nowMs - lastSeen : Number.POSITIVE_INFINITY;
          if (ageMs <= opts.deadGraceMs) kept.push(entry);
        }
        const removed = current.entries.length - kept.length;
        if (removed === 0) {
          this.state = current;
          return 0;
        }
        const nextState = { entries: kept.map(cloneEntry) };
        await this.persistState(this.filePath, nextState);
        this.state = nextState;
        return removed;
      });
    });
  }

  async getByPeerId(peerId: PeerId): Promise<WakeRegistryEntry | null> {
    return this.withLock(async () => {
      this.state = await this.readStateFromDisk();
      const entry = this.state.entries.find((candidate) => candidate.peer_id === peerId);
      return entry ? cloneEntry(entry) : null;
    });
  }

  async markSeen(peerId: PeerId, at = new Date().toISOString()): Promise<void> {
    await this.withLock(async () => {
      await this.withDiskLock(async () => {
        const current = await this.readStateFromDisk();
        const nextEntries = current.entries.map((entry) =>
          entry.peer_id === peerId
            ? { ...entry, last_seen_at: at, updated_at: at, status: "ready" as const }
            : cloneEntry(entry)
        );
        await this.persistState(this.filePath, { entries: nextEntries });
        this.state = { entries: nextEntries };
      });
    });
  }

  private async isLive(entry: WakeRegistryEntry): Promise<boolean> {
    if (!isProcessAlive(entry.app_server_pid)) return false;
    if (!isProcessAlive(entry.mcp_pid)) return false;
    if (entry.tui_pid !== null && !isProcessAlive(entry.tui_pid)) return false;
    if (!(await socketPathExists(entry.app_server_socket_path))) return false;
    return true;
  }

  private async readStateFromDisk(): Promise<WakeRegistryState> {
    try {
      if (IS_POSIX) {
        const st = await stat(this.filePath);
        if (!st.isFile()) return { entries: [] };
        const mine = (process as unknown as { getuid?: () => number }).getuid?.();
        if (typeof mine === "number" && st.uid !== mine) return { entries: [] };
        if ((st.mode & 0o777) !== FILE_MODE) return { entries: [] };
      }

      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WakeRegistryState>;
      if (!Array.isArray(parsed.entries)) return { entries: [] };
      return { entries: parsed.entries.map((entry) => cloneEntry(entry as WakeRegistryEntry)) };
    } catch {
      return { entries: [] };
    }
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    if (IS_POSIX) await chmod(dir, DIR_MODE);
  }

  private async withDiskLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    return withInterprocessFileLock(`${this.filePath}.lock`, fn);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
