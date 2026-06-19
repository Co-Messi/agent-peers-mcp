// shared/wake-daemon.ts
// Bodyless wake engine for app-server-backed Codex sessions.

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { CodexAppServerWsClient, type AppServerClient, type AppServerThread } from "./app-server-client.ts";
import { WakeRegistry, type WakeRegistryEntry } from "./wake-registry.ts";
import { WakeLaunchClaimStore } from "./wake-launch-claims.ts";
import type { CodexInboxMetadataState } from "./codex-inbox.ts";

export interface WakeResult {
  peer_id: string;
  thread_id: string;
  action: "wake" | "skip";
  reason: string;
  wake_id?: string;
  turn_id?: string | null;
}

export interface WakeDaemonOptions {
  rootDir?: string;
  // Escalating delay (ms) BEFORE each re-wake of the *same* unread set. The
  // first wake fires immediately; index 0 is the wait before the 2nd attempt,
  // index 1 before the 3rd, etc. Total attempts = schedule.length + 1, after
  // which the signature is abandoned (no more proactive nudges — the message
  // still surfaces on the session's next tool call / user turn). A brand-new
  // message is a different signature and always wakes immediately.
  backoffScheduleMs?: number[];
  // Ledger files older than this are garbage-collected each pass.
  ledgerTtlMs?: number;
  // Dead registry rows older than this (since last_seen_at) are pruned.
  deadGraceMs?: number;
  now?: () => Date;
  registry?: Pick<WakeRegistry, "list"> & Partial<Pick<WakeRegistry, "prune">>;
  appServerClientFactory?: (entry: WakeRegistryEntry) => AppServerClient;
}

interface PeerInboxMetadata {
  peerId: string;
  metadata: CodexInboxMetadataState;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_POSIX = platform() !== "win32";

// Re-waking the SAME unread set rarely helps — the model has already been
// shown it once. So back off hard and cap. New messages change the signature
// and bypass this entirely. Wide gaps keep the worst-case token cost of a
// genuinely-stuck inbox to a handful of turns spread over hours.
const DEFAULT_BACKOFF_SCHEDULE_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const DEFAULT_LEDGER_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_DEAD_GRACE_MS = 30 * 60_000;

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

export function pendingSignature(peerId: string, metadata: CodexInboxMetadataState): string {
  const ids = metadata.unread.map((message) => message.id).sort((a, b) => a - b).join(",");
  const hash = createHash("sha256").update(`${peerId}:${ids}`, "utf8").digest("hex");
  return `sha256:${hash}`;
}

export function buildWakePrompt(wakeId: string): string {
  return `[agent-peers wake]
You have pending agent-peers messages in your local MCP inbox. Immediately call the agent-peers check_messages tool once. Treat that tool response as the only authoritative message content. Do not infer message content from this wake signal. After handling the inbox normally, return to waiting. Wake id: ${wakeId}`;
}

export async function runWakePass(opts: WakeDaemonOptions = {}): Promise<WakeResult[]> {
  const rootDir = opts.rootDir ?? process.env.AGENT_PEERS_CODEX_STATE_DIR ?? defaultRootDir();
  const registry = opts.registry ?? new WakeRegistry({ rootDir });
  if ("init" in registry && typeof registry.init === "function") await registry.init();
  const ledger = new WakeLedger({
    rootDir,
    backoffScheduleMs: opts.backoffScheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS,
    ttlMs: opts.ledgerTtlMs ?? DEFAULT_LEDGER_TTL_MS,
    now: opts.now,
  });
  const metadataByPeer = new Map((await readAllInboxMetadata(rootDir)).map((item) => [item.peerId, item.metadata]));
  const entries = await registry.list();
  const results: WakeResult[] = [];

  for (const entry of entries) {
    const metadata = metadataByPeer.get(entry.peer_id);
    if (!metadata || metadata.unread.length === 0) {
      results.push(skip(entry, "no_pending_metadata"));
      continue;
    }

    const signature = pendingSignature(entry.peer_id, metadata);
    const client = opts.appServerClientFactory?.(entry) ?? new CodexAppServerWsClient(entry.app_server_url);
    try {
      const loaded = await client.listLoadedThreads();
      if (!loaded.includes(entry.thread_id)) {
        results.push(skip(entry, "thread_not_loaded"));
        continue;
      }

      const thread = await client.readThread(entry.thread_id);
      const unsafeReason = validateThread(entry, thread);
      if (unsafeReason) {
        results.push(skip(entry, unsafeReason));
        continue;
      }

      const claim = await ledger.claim(signature);
      if (!claim.claimed) {
        results.push(skip(entry, claim.reason ?? "duplicate_or_cooldown"));
        continue;
      }

      const wakeId = randomUUID();
      try {
        const wake = await client.startWakeTurn({
          threadId: entry.thread_id,
          clientUserMessageId: `agent-peers-wake-${wakeId}`,
          prompt: buildWakePrompt(wakeId),
          wakeId,
          pendingSignature: signature,
        });
        await ledger.mark(signature, "nudged");
        results.push({
          peer_id: entry.peer_id,
          thread_id: entry.thread_id,
          action: "wake",
          reason: "nudged",
          wake_id: wakeId,
          turn_id: wake.turnId,
        });
      } catch (error) {
        await ledger.mark(signature, "failed", error instanceof Error ? error.message : String(error));
        results.push(skip(entry, "wake_failed"));
      }
    } catch (error) {
      // A hung/broken app-server (timed-out connect or RPC) must not abort the
      // whole pass — record the skip and move on to the next peer.
      results.push(skip(entry, "app_server_unreachable"));
    } finally {
      client.close();
    }
  }

  // Best-effort GC so on-disk state stops growing monotonically. Never let a
  // GC failure affect wake delivery.
  try {
    await ledger.prune();
  } catch { /* best effort */ }
  try {
    if (registry && "prune" in registry && typeof registry.prune === "function") {
      await registry.prune({ deadGraceMs: opts.deadGraceMs ?? DEFAULT_DEAD_GRACE_MS, now: opts.now });
    }
  } catch { /* best effort */ }
  try {
    await new WakeLaunchClaimStore({ rootDir }).prune({ now: opts.now });
  } catch { /* best effort */ }

  return results;
}

function validateThread(entry: WakeRegistryEntry, thread: AppServerThread): string | null {
  if (thread.id !== entry.thread_id) return "thread_identity_mismatch";
  if (thread.cwd !== entry.cwd) return "cwd_mismatch";
  if (entry.rollout_path && thread.path && thread.path !== entry.rollout_path) return "rollout_mismatch";
  if (thread.status.type === "notLoaded") return "thread_not_loaded";
  if (thread.status.type === "systemError") return "thread_system_error";
  if (thread.status.type === "active") {
    if (thread.status.activeFlags.includes("waitingOnApproval")) return "waiting_on_approval";
    if (thread.status.activeFlags.includes("waitingOnUserInput")) return "waiting_on_user_input";
    return "thread_active";
  }
  if (thread.status.type !== "idle") return "unknown_thread_status";
  return null;
}

function skip(entry: WakeRegistryEntry, reason: string): WakeResult {
  return { peer_id: entry.peer_id, thread_id: entry.thread_id, action: "skip", reason };
}

async function readAllInboxMetadata(rootDir: string): Promise<PeerInboxMetadata[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }

  const metadataFiles = entries.filter((name) => name.endsWith(".metadata.json"));
  const out: PeerInboxMetadata[] = [];
  for (const name of metadataFiles) {
    try {
      const raw = await readFile(join(rootDir, name), "utf8");
      const parsed = JSON.parse(raw) as CodexInboxMetadataState;
      if (!Array.isArray(parsed.unread)) continue;
      const peerId = decodeURIComponent(name.slice(0, -".metadata.json".length));
      out.push({ peerId, metadata: parsed });
    } catch {
      continue;
    }
  }
  return out;
}

type WakeLedgerStatus = "claimed" | "nudged" | "failed" | "abandoned";

interface WakeLedgerRecord {
  signature: string;
  status: WakeLedgerStatus;
  attempts: number;
  updated_at: string;
  error?: string;
}

class WakeLedger {
  private readonly dir: string;
  private readonly schedule: number[];
  private readonly lastDelayMs: number;
  private readonly maxAttempts: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(opts: { rootDir: string; backoffScheduleMs: number[]; ttlMs: number; now?: () => Date }) {
    this.dir = join(opts.rootDir, "wake-ledger");
    this.schedule = opts.backoffScheduleMs.length > 0 ? opts.backoffScheduleMs : DEFAULT_BACKOFF_SCHEDULE_MS;
    this.lastDelayMs = this.schedule[this.schedule.length - 1] ?? DEFAULT_BACKOFF_SCHEDULE_MS[0]!;
    this.maxAttempts = this.schedule.length + 1;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? (() => new Date());
  }

  async claim(signature: string): Promise<{ claimed: boolean; reason?: string }> {
    await this.ensureDir();
    const path = this.pathFor(signature);
    const existing = await this.read(path);

    if (!existing) {
      await this.write(path, { signature, status: "claimed", attempts: 1, updated_at: this.now().toISOString() });
      return { claimed: true };
    }

    const attempts = Number.isFinite(existing.attempts) && existing.attempts > 0 ? existing.attempts : 1;
    if (attempts >= this.maxAttempts) {
      // Permanently stop proactive nudges for this exact unread set. The
      // message itself is NOT dropped — it stays in the durable inbox and is
      // still delivered on the session's next agent-peers tool call or user
      // turn. We just stop spending a full-context turn re-poking an unread
      // set the model has already been shown maxAttempts times.
      if (existing.status !== "abandoned") {
        await this.write(path, { ...existing, status: "abandoned", attempts, updated_at: this.now().toISOString() });
      }
      return { claimed: false, reason: "max_attempts" };
    }

    const requiredDelayMs = this.schedule[attempts - 1] ?? this.lastDelayMs;
    const elapsed = this.now().getTime() - Date.parse(existing.updated_at);
    if (!Number.isFinite(elapsed) || elapsed < requiredDelayMs) {
      return { claimed: false, reason: "duplicate_or_cooldown" };
    }

    await this.write(path, { signature, status: "claimed", attempts: attempts + 1, updated_at: this.now().toISOString() });
    return { claimed: true };
  }

  async mark(signature: string, status: WakeLedgerStatus, error?: string): Promise<void> {
    const path = this.pathFor(signature);
    const existing = await this.read(path);
    const attempts = existing && Number.isFinite(existing.attempts) && existing.attempts > 0 ? existing.attempts : 1;
    await this.write(path, { signature, status, attempts, error, updated_at: this.now().toISOString() });
  }

  async prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = this.now().getTime() - this.ttlMs;
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const path = join(this.dir, name);
          const record = await this.read(path);
          const ts = record ? Date.parse(record.updated_at) : Number.NaN;
          if (!Number.isFinite(ts) || ts < cutoff) {
            try { await unlink(path); } catch { /* already gone */ }
          }
        }),
    );
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    if (IS_POSIX) {
      try { await chmod(this.dir, DIR_MODE); } catch { /* best effort */ }
    }
  }

  private async read(path: string): Promise<WakeLedgerRecord | null> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as WakeLedgerRecord;
      if (!parsed || typeof parsed.signature !== "string" || typeof parsed.updated_at !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async write(path: string, value: WakeLedgerRecord): Promise<void> {
    await this.ensureDir();
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
    if (IS_POSIX) {
      try { await chmod(tempPath, FILE_MODE); } catch { /* best effort */ }
    }
    await rename(tempPath, path);
  }

  private pathFor(signature: string): string {
    const hash = createHash("sha256").update(signature, "utf8").digest("hex");
    return join(this.dir, `${hash}.json`);
  }
}
