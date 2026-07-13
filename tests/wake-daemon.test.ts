import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-wake-daemon-"));
  tempDirs.push(dir);
  return dir;
}

function entry(overrides: Partial<WakeRegistryEntry> = {}): WakeRegistryEntry {
  const now = "2026-06-18T00:00:00.000Z";
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
    ...overrides,
  };
}

function metadata(overrides: Partial<CodexInboxMetadataState> = {}): CodexInboxMetadataState {
  return {
    unread: [{
      id: 10,
      to_id: "peer-1",
      sent_at: "2026-06-18T00:00:00.000Z",
    }],
    updated_at: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

async function writeMetadata(rootDir: string, peerId = "peer-1", value = metadata()): Promise<string> {
  const path = join(rootDir, `${encodeURIComponent(peerId)}.metadata.json`);
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

class MockClient implements AppServerClient {
  startCalls: Array<{ prompt: string; clientUserMessageId: string; pendingSignature: string }> = [];
  constructor(
    private readonly thread: AppServerThread,
    private readonly loaded: string[] = [thread.id],
    private readonly failStart = false,
  ) {}

  async listLoadedThreads(): Promise<string[]> {
    return this.loaded;
  }

  async readThread(): Promise<AppServerThread> {
    return this.thread;
  }

  async startWakeTurn(params: {
    clientUserMessageId: string;
    prompt: string;
    pendingSignature: string;
  }): Promise<{ turnId: string | null }> {
    this.startCalls.push(params);
    if (this.failStart) throw new Error("boom");
    return { turnId: "turn-1" };
  }

  close(): void {}
}

function idleThread(overrides: Partial<AppServerThread> = {}): AppServerThread {
  return {
    id: "thread-1",
    cwd: "/repo",
    path: "/rollout.jsonl",
    status: { type: "idle" },
    ...overrides,
  };
}

test("runWakePass nudges loaded idle thread with a bodyless prompt", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new MockClient(idleThread());

  const results = await runWakePass({
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  });

  expect(results[0]?.action).toBe("wake");
  expect(results[0]?.reason).toBe("nudged");
  expect(client.startCalls).toHaveLength(1);
  expect(client.startCalls[0]?.prompt).toContain("call the agent-peers check_messages tool once");
  expect(client.startCalls[0]?.prompt).not.toContain("sender-peer");
  expect(client.startCalls[0]?.prompt).not.toContain("working elsewhere");
});

test("runWakePass refuses not-loaded threads", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new MockClient(idleThread(), []);

  const results = await runWakePass({
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
  });

  expect(results).toEqual([{
    peer_id: "peer-1",
    peer_name: "wake-peer",
    cwd: "/repo",
    thread_id: "thread-1",
    action: "skip",
    reason: "thread_not_loaded",
    log: true,
  }]);
  expect(client.startCalls).toHaveLength(0);
});

test("runWakePass refuses active, approval-wait, and user-input-wait threads", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const cases = [
    [idleThread({ status: { type: "active", activeFlags: [] } }), "thread_active"],
    [idleThread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }), "waiting_on_approval"],
    [idleThread({ status: { type: "active", activeFlags: ["waitingOnUserInput"] } }), "waiting_on_user_input"],
  ] as const;

  for (const [thread, reason] of cases) {
    const client = new MockClient(thread);
    const results = await runWakePass({
      rootDir: await makeDirWithMetadata(),
      registry: { list: async () => [entry()] },
      appServerClientFactory: () => client,
    });
    expect(results[0]?.reason).toBe(reason);
    expect(client.startCalls).toHaveLength(0);
  }
});

test("runWakePass refuses ambiguous identity states", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new MockClient(idleThread({ cwd: "/other-repo" }));

  const results = await runWakePass({
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
  });

  expect(results[0]?.reason).toBe("cwd_mismatch");
  expect(client.startCalls).toHaveLength(0);
});

test("runWakePass duplicate signatures produce at most one nudge", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new MockClient(idleThread());

  const opts = {
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  };

  const first = await runWakePass(opts);
  const second = await runWakePass(opts);

  expect(first[0]?.action).toBe("wake");
  expect(["duplicate_or_cooldown", "peer_wake_rate_limited"]).toContain(second[0]?.reason ?? "");
  expect(client.startCalls).toHaveLength(1);
});

test("new unread signatures cannot bypass the per-peer wake budget", async () => {
  const rootDir = await makeDir();
  const metadataPath = await writeMetadata(rootDir);
  const client = new MockClient(idleThread());
  let now = Date.parse("2026-06-18T00:00:00.000Z");
  const opts = {
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    minWakeIntervalMs: 30_000,
    now: () => new Date(now),
  };

  expect((await runWakePass(opts))[0]?.action).toBe("wake");
  await writeFile(metadataPath, JSON.stringify(metadata({
    unread: [...metadata().unread, { ...metadata().unread[0]!, id: 11 }],
  })), "utf8");
  now += 1_000;
  expect((await runWakePass(opts))[0]?.reason).toBe("peer_wake_rate_limited");
  expect(client.startCalls).toHaveLength(1);
  now += 30_000;
  expect((await runWakePass(opts))[0]?.action).toBe("wake");
  expect(client.startCalls).toHaveLength(2);
});

test("runWakePass failed wake leaves metadata untouched", async () => {
  const rootDir = await makeDir();
  const metadataPath = await writeMetadata(rootDir);
  const before = await readFile(metadataPath, "utf8");
  const client = new MockClient(idleThread(), ["thread-1"], true);

  const results = await runWakePass({
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
  });

  const after = await readFile(metadataPath, "utf8");
  expect(results[0]?.reason).toBe("wake_failed");
  expect(after).toBe(before);
});

async function makeDirWithMetadata(): Promise<string> {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  return rootDir;
}
