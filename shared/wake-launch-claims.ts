// shared/wake-launch-claims.ts
// Sidecar handshake between the wakeable launcher and the Codex MCP child.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { withInterprocessFileLock } from "./file-lock.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_POSIX = platform() !== "win32";

export type WakeLaunchClaimStatus = "starting" | "ready" | "consumed" | "failed";

export interface WakeLaunchClaim {
  claim_id: string;
  cwd: string;
  tty: string | null;
  requested_peer_name: string | null;
  app_server_url: string | null;
  app_server_pid: number | null;
  app_server_socket_path: string | null;
  thread_id: string | null;
  rollout_path: string | null;
  tui_pid: number | null;
  status: WakeLaunchClaimStatus;
  created_at: string;
  updated_at: string;
  consumed_by_peer_id: string | null;
}

export interface CompleteWakeLaunchClaim extends WakeLaunchClaim {
  app_server_url: string;
  app_server_pid: number;
  thread_id: string;
}

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (IS_POSIX) {
    try { await chmod(path, DIR_MODE); } catch { /* best effort */ }
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
  if (IS_POSIX) {
    try { await chmod(tempPath, FILE_MODE); } catch { /* best effort */ }
  }
  await rename(tempPath, path);
}

function isCompleteClaim(claim: WakeLaunchClaim): claim is CompleteWakeLaunchClaim {
  return (claim.status === "ready" || claim.status === "consumed")
    && typeof claim.app_server_url === "string"
    && claim.app_server_url.length > 0
    && typeof claim.app_server_pid === "number"
    && claim.app_server_pid > 0
    && typeof claim.thread_id === "string"
    && claim.thread_id.length > 0;
}

function isRecent(claim: WakeLaunchClaim, maxAgeMs: number): boolean {
  return Date.now() - Date.parse(claim.created_at) <= maxAgeMs;
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

function isLiveClaim(claim: WakeLaunchClaim): boolean {
  return isCompleteClaim(claim)
    && isProcessAlive(claim.app_server_pid)
    && (claim.tui_pid === null || isProcessAlive(claim.tui_pid));
}

export class WakeLaunchClaimStore {
  private readonly dir: string;

  constructor(opts: { rootDir?: string } = {}) {
    this.dir = join(opts.rootDir ?? process.env.AGENT_PEERS_CODEX_STATE_DIR ?? defaultRootDir(), "wake-launch-claims");
  }

  async create(opts: {
    cwd: string;
    tty: string | null;
    requestedPeerName?: string;
  }): Promise<WakeLaunchClaim> {
    await ensurePrivateDir(this.dir);
    const now = new Date().toISOString();
    const claim: WakeLaunchClaim = {
      claim_id: randomUUID(),
      cwd: opts.cwd,
      tty: opts.tty,
      requested_peer_name: opts.requestedPeerName ?? null,
      app_server_url: null,
      app_server_pid: null,
      app_server_socket_path: null,
      thread_id: null,
      rollout_path: null,
      tui_pid: null,
      status: "starting",
      created_at: now,
      updated_at: now,
      consumed_by_peer_id: null,
    };
    await atomicWriteJson(this.pathFor(claim.claim_id), claim);
    return claim;
  }

  async update(claimId: string, patch: Partial<Omit<WakeLaunchClaim, "claim_id" | "created_at">>): Promise<WakeLaunchClaim | null> {
    await ensurePrivateDir(this.dir);
    const path = this.pathFor(claimId);
    return withInterprocessFileLock(`${path}.lock`, async () => {
    const existing = await this.read(claimId);
    if (!existing) return null;
    const next: WakeLaunchClaim = {
      ...existing,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    await atomicWriteJson(path, next);
    return next;
    });
  }

  async findMatching(opts: {
    cwd: string;
    tty: string | null;
    waitMs?: number;
    maxAgeMs?: number;
    includeConsumed?: boolean;
  }): Promise<CompleteWakeLaunchClaim | null> {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000;

    while (true) {
      const claims = await this.list();
      const matching = claims
        .filter((claim) =>
          claim.cwd === opts.cwd
          && claim.tty === opts.tty
          && (opts.includeConsumed || claim.status !== "consumed")
          && claim.status !== "failed"
          && (isRecent(claim, maxAgeMs) || isLiveClaim(claim))
        )
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

      const complete = matching.find(isCompleteClaim);
      if (complete) return complete;
      if (matching.length === 0 || Date.now() >= deadline) return null;
      await Bun.sleep(100);
    }
  }

  // Like findMatching, but returns EVERY complete candidate (newest first)
  // with a liveness flag, instead of just the first. repair-wake uses this to
  // detect the dangerous case where two distinct live sessions share a
  // cwd/tty — in which case attaching to "the newest" could wire the wake
  // pointer to the wrong thread. When requestedPeerName is given and any
  // candidate's requested_peer_name matches, the result is narrowed to those.
  async listMatchingCandidates(opts: {
    cwd: string;
    tty: string | null;
    maxAgeMs?: number;
    includeConsumed?: boolean;
    requestedPeerName?: string | null;
  }): Promise<Array<CompleteWakeLaunchClaim & { live: boolean }>> {
    const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000;
    const claims = await this.list();
    let matching = claims
      .filter((claim) =>
        claim.cwd === opts.cwd
        && claim.tty === opts.tty
        && (opts.includeConsumed || claim.status !== "consumed")
        && claim.status !== "failed"
        && (isRecent(claim, maxAgeMs) || isLiveClaim(claim))
      )
      .filter(isCompleteClaim);

    if (opts.requestedPeerName) {
      const named = matching.filter((claim) => claim.requested_peer_name === opts.requestedPeerName);
      if (named.length > 0) matching = named;
    }

    return matching
      .map((claim) => ({ ...claim, live: isLiveClaim(claim) }))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  async consume(claimId: string, peerId: string): Promise<void> {
    await this.update(claimId, {
      status: "consumed",
      consumed_by_peer_id: peerId,
    });
  }

  async remove(claimId: string): Promise<void> {
    await ensurePrivateDir(this.dir);
    const path = this.pathFor(claimId);
    await withInterprocessFileLock(`${path}.lock`, async () => {
      try { await unlink(path); } catch { /* already gone */ }
    });
  }

  // Garbage-collect claim files that are neither live nor recent. A claim is
  // kept while its app-server (and TUI, if any) is alive, or while it is still
  // within maxAgeMs of creation (so a just-started "starting" claim is never
  // reaped before the MCP child has a chance to consume it). Everything else
  // is a dead/abandoned handshake artifact and is removed. Returns the count
  // pruned.
  async prune(opts: { maxAgeMs?: number; now?: () => Date } = {}): Promise<number> {
    const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000;
    const nowMs = (opts.now ?? (() => new Date()))().getTime();
    const claims = await this.list();
    let removed = 0;
    for (const claim of claims) {
      const createdMs = Date.parse(claim.created_at);
      const recent = Number.isFinite(createdMs) && nowMs - createdMs <= maxAgeMs;
      if (isLiveClaim(claim) || recent) continue;
      await this.remove(claim.claim_id);
      removed += 1;
    }
    return removed;
  }

  async list(): Promise<WakeLaunchClaim[]> {
    try {
      await ensurePrivateDir(this.dir);
      const names = await readdir(this.dir);
      const claims: WakeLaunchClaim[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const claimId = name.slice(0, -".json".length);
        const claim = await this.read(claimId);
        if (claim) claims.push(claim);
      }
      return claims;
    } catch {
      return [];
    }
  }

  async read(claimId: string): Promise<WakeLaunchClaim | null> {
    try {
      const raw = await readFile(this.pathFor(claimId), "utf8");
      const parsed = JSON.parse(raw) as WakeLaunchClaim;
      if (!parsed || parsed.claim_id !== claimId || typeof parsed.cwd !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private pathFor(claimId: string): string {
    return join(this.dir, `${claimId}.json`);
  }
}
