import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AppServerClient, AppServerThread } from "../shared/app-server-client.ts";
import { runWakePass } from "../shared/wake-daemon.ts";
import type { WakeRegistryEntry } from "../shared/wake-registry.ts";
import type { CodexInboxMetadataState } from "../shared/codex-inbox.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-wake-observe-"));
  tempDirs.push(dir);
  return dir;
}

function entry(): WakeRegistryEntry {
  const now = "2026-06-22T00:00:00.000Z";
  return {
    peer_id: "peer-1",
    peer_name: "wake-peer",
    cwd: "/repo",
    git_root: "/repo",
    tty: "ttys001",
    thread_id: "thread-1",
    rollout_path: "/rollout.jsonl",
    app_server_url: "ws://127.0.0.1:41037",
    app_server_socket_path: null,
    app_server_pid: process.pid,
    tui_pid: null,
    mcp_pid: process.pid,
    broker_session_token_hash: "sha256:abc",
    status: "ready",
    capabilities: ["app-server-ws"],
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
}

async function writeMetadata(rootDir: string): Promise<void> {
  const value: CodexInboxMetadataState = {
    unread: [{
      id: 10,
      from_id: "sender",
      from_name: "sender-peer",
      from_peer_type: "claude",
      from_cwd: "/other",
      from_summary: "working elsewhere",
      to_id: "peer-1",
      sent_at: "2026-06-22T00:00:00.000Z",
    }],
    updated_at: "2026-06-22T00:00:00.000Z",
  };
  await writeFile(join(rootDir, `${encodeURIComponent("peer-1")}.metadata.json`), JSON.stringify(value, null, 2), "utf8");
}

// A client whose thread status can be swapped between passes; counts how many
// times the daemon actually round-trips to the app-server.
class StatusClient implements AppServerClient {
  reads = 0;
  startCalls = 0;
  status: AppServerThread["status"] = { type: "idle" };
  constructor(status: AppServerThread["status"]) { this.status = status; }
  async listLoadedThreads(): Promise<string[]> { return ["thread-1"]; }
  async readThread(): Promise<AppServerThread> {
    this.reads += 1;
    return { id: "thread-1", cwd: "/repo", path: "/rollout.jsonl", status: this.status };
  }
  async startWakeTurn(): Promise<{ turnId: string | null }> {
    this.startCalls += 1;
    return { turnId: "turn" };
  }
  close(): void {}
}

test("systemError is logged once with a bounce hint, then backed off without re-polling", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new StatusClient({ type: "systemError" });
  let nowMs = Date.parse("2026-06-22T00:00:00.000Z");
  const opts = {
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    now: () => new Date(nowMs),
  };

  // Pass 1: detected -> logged, with a "bounce it" note, one round-trip.
  let result = (await runWakePass(opts))[0]!;
  expect(result.reason).toBe("thread_system_error");
  expect(result.log).toBe(true);
  expect(result.note).toContain("codexpeer");
  expect(result.note).toContain("/repo");
  expect(client.reads).toBe(1);

  // Pass 2, five seconds later: inside the 5-minute cooldown -> skipped with NO
  // round-trip and NOT logged.
  nowMs += 5_000;
  result = (await runWakePass(opts))[0]!;
  expect(result.reason).toBe("thread_system_error");
  expect(result.log).toBe(false);
  expect(client.reads).toBe(1);

  // Past the 5-minute cooldown: re-checks (round-trip), still wedged -> a single
  // escalated heartbeat line.
  nowMs += 5 * 60_000 + 1_000;
  result = (await runWakePass(opts))[0]!;
  expect(result.reason).toBe("thread_system_error");
  expect(result.log).toBe(true);
  expect(result.note).toContain("still thread_system_error");
  expect(client.reads).toBe(2);
});

test("a recovered systemError peer is woken and its observation state resets", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new StatusClient({ type: "systemError" });
  let nowMs = Date.parse("2026-06-22T00:00:00.000Z");
  const opts = {
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    now: () => new Date(nowMs),
  };

  expect((await runWakePass(opts))[0]?.reason).toBe("thread_system_error");

  // Thread recovers; advance past the cooldown so the daemon re-checks.
  client.status = { type: "idle" };
  nowMs += 5 * 60_000 + 1_000;
  const woke = (await runWakePass(opts))[0]!;
  expect(woke.action).toBe("wake");
  expect(client.startCalls).toBe(1);

  // Observation state was reset on the nudge; the wake ledger now governs the
  // same unread set on the normal cooldown.
  nowMs += 1_000;
  expect((await runWakePass(opts))[0]?.reason).toBe("duplicate_or_cooldown");
});

test("repeated active skips are coalesced but the peer keeps being polled", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new StatusClient({ type: "active", activeFlags: [] });
  let nowMs = Date.parse("2026-06-22T00:00:00.000Z");
  const opts = {
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    now: () => new Date(nowMs),
  };

  // Transition logs.
  expect((await runWakePass(opts))[0]?.log).toBe(true);

  // Within the heartbeat window -> suppressed, but still polled (no backoff for a
  // merely-busy peer; we want to deliver the moment it goes idle).
  nowMs += 5_000;
  expect((await runWakePass(opts))[0]?.log).toBe(false);

  // After the heartbeat window -> one "still" line.
  nowMs += 30 * 60_000 + 1_000;
  const beat = (await runWakePass(opts))[0]!;
  expect(beat.log).toBe(true);
  expect(beat.note).toContain("still thread_active");

  expect(client.reads).toBe(3);
});
