// shared/wake-daemon.ts
// Bodyless wake engine for app-server-backed Codex sessions.

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { CodexAppServerWsClient, type AppServerClient, type AppServerThread } from "./app-server-client.ts";
import { withInterprocessFileLock } from "./file-lock.ts";
import { WakeRegistry, type WakeRegistryEntry } from "./wake-registry.ts";
import { WakeLaunchClaimStore } from "./wake-launch-claims.ts";
import { readCodexInboxMetadataFile, type CodexInboxMetadataState } from "./codex-inbox.ts";

export interface WakeResult {
  peer_id: string;
  peer_name: string;
  cwd: string;
  thread_id: string;
  action: "wake" | "skip";
  reason: string;
  // Whether the daemon should print this line. The observation log coalesces
  // repeated skips (a peer stuck in the same state every 5s) down to a single
  // transition line plus occasional heartbeats, so a wedged or busy peer no
  // longer floods the log. `--json` and the manual `wake` command ignore this
  // and emit every result.
  log: boolean;
  // Optional human-readable hint attached to a notable line (e.g. how to bounce
  // a peer whose thread is wedged in a system error).
  note?: string;
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
  // Hard per-peer budget across all unread signatures. New messages coalesce
  // during this interval instead of creating an unbounded sequence of turns.
  minWakeIntervalMs?: number;
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
const DEFAULT_MIN_WAKE_INTERVAL_MS = 30_000;

function configuredMinWakeIntervalMs(): number {
  const raw = process.env.CODEX_PEER_MIN_WAKE_INTERVAL_MS;
  if (!raw) return DEFAULT_MIN_WAKE_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MIN_WAKE_INTERVAL_MS;
}

// Skip reasons that mean the peer's thread is genuinely WEDGED (not just busy):
// it has hit a system-level error and cannot be woken until a human bounces it.
// These get an escalating re-check backoff so the daemon stops round-tripping +
// re-logging them every pass. A merely-`active` peer is NOT wedged — its user is
// mid-turn — so it keeps getting polled every pass (we want low-latency delivery
// the moment it goes idle); only its log lines are coalesced.
const OBSERVE_BACKOFF_REASONS = new Set(["thread_system_error"]);
const OBSERVE_SYSTEMERROR_SCHEDULE_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const OBSERVE_HEARTBEAT_MS = 30 * 60_000;

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
You have pending agent-peers messages in your local MCP inbox. Immediately call the agent-peers check_messages tool once. Treat that tool response as the only authoritative message content. Do not infer message content from this wake signal. After processing the displayed messages, call ack_messages with their exact message IDs, then return to waiting. Wake id: ${wakeId}`;
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
  const observe = new WakeObservationLog({ rootDir, now: opts.now });
  const wakeRate = new WakeRateLimiter({
    rootDir,
    minIntervalMs: opts.minWakeIntervalMs ?? configuredMinWakeIntervalMs(),
    now: opts.now,
  });
  const metadataByPeer = new Map((await readAllInboxMetadata(rootDir)).map((item) => [item.peerId, item.metadata]));
  const entries = await registry.list();
  const results: WakeResult[] = [];

  // Build a skip and run it through the observation log, which decides whether
  // the line is worth printing (a state transition or a periodic heartbeat) vs.
  // a suppressed repeat, and attaches any human note (e.g. how to bounce a
  // wedged peer).
  const annotatedSkip = async (entry: WakeRegistryEntry, reason: string): Promise<WakeResult> => {
    const result = skip(entry, reason);
    const decision = await observe.annotate(entry.peer_id, reason, entry.cwd);
    result.log = decision.log;
    if (decision.note) result.note = decision.note;
    return result;
  };

  for (const entry of entries) {
    const metadata = metadataByPeer.get(entry.peer_id);
    if (!metadata || metadata.unread.length === 0) {
      results.push(skip(entry, "no_pending_metadata"));
      continue;
    }

    // A peer we already know is wedged (systemError) is re-checked on an
    // escalating backoff, not every pass. While inside its cooldown window we
    // skip the app-server round-trip AND the log line entirely; the thread
    // can't be woken until it's bounced, so there is nothing to gain by
    // re-poking it every 5 seconds.
    const recheck = await observe.recheckBackoff(entry.peer_id);
    if (recheck.skip) {
      results.push(skip(entry, recheck.reason ?? "thread_system_error"));
      continue;
    }

    const signature = pendingSignature(entry.peer_id, metadata);
    const client = opts.appServerClientFactory?.(entry) ?? new CodexAppServerWsClient(entry.app_server_url);
    try {
      const loaded = await client.listLoadedThreads();
      if (!loaded.includes(entry.thread_id)) {
        results.push(await annotatedSkip(entry, "thread_not_loaded"));
        continue;
      }

      const thread = await client.readThread(entry.thread_id);
      const unsafeReason = validateThread(entry, thread);
      if (unsafeReason) {
        results.push(await annotatedSkip(entry, unsafeReason));
        continue;
      }

      const rateClaim = await wakeRate.claim(entry.peer_id);
      if (!rateClaim.claimed) {
        results.push(await annotatedSkip(entry, "peer_wake_rate_limited"));
        continue;
      }

      const claim = await ledger.claim(signature);
      if (!claim.claimed) {
        await wakeRate.release(entry.peer_id, rateClaim);
        results.push(await annotatedSkip(entry, claim.reason ?? "duplicate_or_cooldown"));
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
        // A successful nudge means the peer is healthy and idle again; clear any
        // prior wedged/coalesced observation state so the next anomaly logs fresh.
        try { await observe.reset(entry.peer_id); } catch { /* wake already succeeded */ }
        results.push({
          peer_id: entry.peer_id,
          peer_name: entry.peer_name,
          cwd: entry.cwd,
          thread_id: entry.thread_id,
          action: "wake",
          reason: "nudged",
          log: true,
          wake_id: wakeId,
          turn_id: wake.turnId,
        });
      } catch (error) {
        await ledger.mark(signature, "failed", error instanceof Error ? error.message : String(error));
        results.push(await annotatedSkip(entry, "wake_failed"));
      }
    } catch (error) {
      // A hung/broken app-server (timed-out connect or RPC) must not abort the
      // whole pass — record the skip and move on to the next peer.
      results.push(await annotatedSkip(entry, "app_server_unreachable"));
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
    await observe.prune(opts.ledgerTtlMs ?? DEFAULT_LEDGER_TTL_MS);
  } catch { /* best effort */ }
  try {
    await wakeRate.prune(opts.ledgerTtlMs ?? DEFAULT_LEDGER_TTL_MS);
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
  // Default log:false — a bare skip is silent unless the observation log
  // (annotatedSkip) promotes it to a transition/heartbeat line.
  return {
    peer_id: entry.peer_id,
    peer_name: entry.peer_name,
    cwd: entry.cwd,
    thread_id: entry.thread_id,
    action: "skip",
    reason,
    log: false,
  };
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
      const peerId = decodeURIComponent(name.slice(0, -".metadata.json".length));
      const parsed = await readCodexInboxMetadataFile(join(rootDir, name), peerId);
      if (!parsed) continue;
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
    return withInterprocessFileLock(`${path}.lock`, async () => {
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
    });
  }

  async mark(signature: string, status: WakeLedgerStatus, error?: string): Promise<void> {
    const path = this.pathFor(signature);
    await this.ensureDir();
    await withInterprocessFileLock(`${path}.lock`, async () => {
      const existing = await this.read(path);
      const attempts = existing && Number.isFinite(existing.attempts) && existing.attempts > 0 ? existing.attempts : 1;
      await this.write(path, { signature, status, attempts, error, updated_at: this.now().toISOString() });
    });
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
          await withInterprocessFileLock(`${path}.lock`, async () => {
            const record = await this.read(path);
            const ts = record ? Date.parse(record.updated_at) : Number.NaN;
            if (!Number.isFinite(ts) || ts < cutoff) {
              try { await unlink(path); } catch { /* already gone */ }
            }
          });
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
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
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

interface WakeRateRecord {
  peer_id: string;
  last_wake_at: string;
  reservation: string;
}

interface WakeRateClaim {
  claimed: boolean;
  reservation?: string;
  previous?: WakeRateRecord | null;
}

class WakeRateLimiter {
  private readonly dir: string;
  private readonly minIntervalMs: number;
  private readonly now: () => Date;

  constructor(opts: { rootDir: string; minIntervalMs: number; now?: () => Date }) {
    this.dir = join(opts.rootDir, "wake-rate");
    this.minIntervalMs = Math.max(0, opts.minIntervalMs);
    this.now = opts.now ?? (() => new Date());
  }

  async claim(peerId: string): Promise<WakeRateClaim> {
    await this.ensureDir();
    const path = this.pathFor(peerId);
    return withInterprocessFileLock(`${path}.lock`, async () => {
      const previous = await this.read(path);
      const elapsed = previous ? this.now().getTime() - Date.parse(previous.last_wake_at) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(elapsed) && elapsed < this.minIntervalMs) return { claimed: false };
      const reservation = randomUUID();
      await this.write(path, { peer_id: peerId, last_wake_at: this.now().toISOString(), reservation });
      return { claimed: true, reservation, previous };
    });
  }

  async release(peerId: string, claim: WakeRateClaim): Promise<void> {
    if (!claim.claimed || !claim.reservation) return;
    const path = this.pathFor(peerId);
    await withInterprocessFileLock(`${path}.lock`, async () => {
      const current = await this.read(path);
      if (current?.reservation !== claim.reservation) return;
      if (claim.previous) await this.write(path, claim.previous);
      else {
        try { await unlink(path); } catch { /* already removed */ }
      }
    });
  }

  async prune(ttlMs: number): Promise<void> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return; }
    const cutoff = this.now().getTime() - ttlMs;
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const path = join(this.dir, name);
      await withInterprocessFileLock(`${path}.lock`, async () => {
        const record = await this.read(path);
        const timestamp = record ? Date.parse(record.last_wake_at) : Number.NaN;
        if (!Number.isFinite(timestamp) || timestamp < cutoff) {
          try { await unlink(path); } catch { /* already removed */ }
        }
      });
    }));
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    if (IS_POSIX) await chmod(this.dir, DIR_MODE);
  }

  private async read(path: string): Promise<WakeRateRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as WakeRateRecord;
      return parsed && typeof parsed.last_wake_at === "string" && typeof parsed.reservation === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async write(path: string, value: WakeRateRecord): Promise<void> {
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
    if (IS_POSIX) await chmod(tempPath, FILE_MODE);
    await rename(tempPath, path);
  }

  private pathFor(peerId: string): string {
    return join(this.dir, `${createHash("sha256").update(peerId, "utf8").digest("hex")}.json`);
  }
}

interface WakeObservationRecord {
  peer_id: string;
  reason: string;
  first_seen_at: string;
  last_logged_at: string;
  log_count: number;
  observe_count: number;
  backoff_index: number;
  next_log_at: string;
  next_check_at?: string;
}

function observeIntervalMs(reason: string, index: number): number {
  if (OBSERVE_BACKOFF_REASONS.has(reason)) {
    const schedule = OBSERVE_SYSTEMERROR_SCHEDULE_MS;
    return schedule[Math.min(Math.max(index, 0), schedule.length - 1)]!;
  }
  return OBSERVE_HEARTBEAT_MS;
}

function observeMaxIndex(reason: string): number {
  return OBSERVE_BACKOFF_REASONS.has(reason) ? OBSERVE_SYSTEMERROR_SCHEDULE_MS.length - 1 : 0;
}

function humanizeMs(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const minutes = Math.round(safe / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

function bounceHint(reason: string, cwd: string): string | undefined {
  if (reason === "thread_system_error") {
    return `peer thread hit a system error (likely a failed/crashed turn) and can't be woken until bounced — close the TUI and relaunch \`codexpeer\` in ${cwd}`;
  }
  return undefined;
}

// Per-peer record of the LAST skip reason the daemon saw, so the bodyless,
// fresh-process-per-pass daemon can coalesce log spam and back off re-checking a
// wedged peer across passes. Keyed by peer id; mirrors WakeLedger's atomic
// read/rename persistence and 0600 file modes.
class WakeObservationLog {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(opts: { rootDir: string; now?: () => Date }) {
    this.dir = join(opts.rootDir, "wake-observe");
    this.now = opts.now ?? (() => new Date());
  }

  // Cheap pre-flight: if this peer is in a wedged state whose cooldown has not
  // yet elapsed, the caller should skip the app-server round-trip entirely.
  async recheckBackoff(peerId: string): Promise<{ skip: boolean; reason?: string }> {
    const record = await this.read(this.pathFor(peerId));
    if (!record || !OBSERVE_BACKOFF_REASONS.has(record.reason) || !record.next_check_at) {
      return { skip: false };
    }
    const next = Date.parse(record.next_check_at);
    if (Number.isFinite(next) && this.now().getTime() < next) {
      return { skip: true, reason: record.reason };
    }
    return { skip: false };
  }

  // Record an observed skip and decide whether it's worth logging. First sight
  // of a reason (or a change of reason) is a transition -> log once. The same
  // reason repeating is suppressed until its next_log_at heartbeat; for wedged
  // reasons the heartbeat interval escalates (5m -> 30m -> 2h) so a permanently
  // stuck peer costs a handful of lines a day instead of thousands.
  async annotate(peerId: string, reason: string, cwd: string): Promise<{ log: boolean; note?: string }> {
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const backoffEligible = OBSERVE_BACKOFF_REASONS.has(reason);
    const record = await this.read(this.pathFor(peerId));

    if (!record || record.reason !== reason) {
      const interval = observeIntervalMs(reason, 0);
      await this.write(peerId, {
        peer_id: peerId,
        reason,
        first_seen_at: nowDate.toISOString(),
        last_logged_at: nowDate.toISOString(),
        log_count: 1,
        observe_count: 1,
        backoff_index: 0,
        next_log_at: new Date(nowMs + interval).toISOString(),
        next_check_at: backoffEligible ? new Date(nowMs + interval).toISOString() : undefined,
      });
      return { log: true, note: bounceHint(reason, cwd) };
    }

    const observeCount = (Number.isFinite(record.observe_count) ? record.observe_count : 1) + 1;
    const dueAt = Date.parse(record.next_log_at);
    if (Number.isFinite(dueAt) && nowMs >= dueAt) {
      const index = Math.min((record.backoff_index ?? 0) + 1, observeMaxIndex(reason));
      const interval = observeIntervalMs(reason, index);
      await this.write(peerId, {
        ...record,
        observe_count: observeCount,
        log_count: (record.log_count ?? 1) + 1,
        last_logged_at: nowDate.toISOString(),
        backoff_index: index,
        next_log_at: new Date(nowMs + interval).toISOString(),
        next_check_at: backoffEligible ? new Date(nowMs + interval).toISOString() : undefined,
      });
      const since = humanizeMs(nowMs - Date.parse(record.first_seen_at));
      const base = `still ${reason} (x${observeCount} over ${since})`;
      const hint = bounceHint(reason, cwd);
      return { log: true, note: hint ? `${base}; ${hint}` : base };
    }

    await this.write(peerId, { ...record, observe_count: observeCount });
    return { log: false };
  }

  async reset(peerId: string): Promise<void> {
    try { await unlink(this.pathFor(peerId)); } catch { /* already gone */ }
  }

  async prune(ttlMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = this.now().getTime() - ttlMs;
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const path = join(this.dir, name);
          const record = await this.read(path);
          const ts = record ? Date.parse(record.last_logged_at) : Number.NaN;
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

  private async read(path: string): Promise<WakeObservationRecord | null> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as WakeObservationRecord;
      if (!parsed || typeof parsed.reason !== "string" || typeof parsed.first_seen_at !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async write(peerId: string, value: WakeObservationRecord): Promise<void> {
    await this.ensureDir();
    const path = this.pathFor(peerId);
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
    if (IS_POSIX) {
      try { await chmod(tempPath, FILE_MODE); } catch { /* best effort */ }
    }
    await rename(tempPath, path);
  }

  private pathFor(peerId: string): string {
    const hash = createHash("sha256").update(peerId, "utf8").digest("hex");
    return join(this.dir, `${hash}.json`);
  }
}
