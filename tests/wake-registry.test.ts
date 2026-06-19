import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

import {
  WakeRegistry,
  hashBrokerSessionToken,
  type WakeRegistryEntry,
} from "../shared/wake-registry.ts";

const IS_POSIX = platform() !== "win32";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-wake-registry-"));
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

test("WakeRegistry persists and reloads entries", async () => {
  const rootDir = await makeDir();
  const first = new WakeRegistry({ rootDir });
  await first.init();
  await first.upsert(entry());

  const second = new WakeRegistry({ rootDir });
  await second.init();
  const entries = await second.list();

  expect(entries).toHaveLength(1);
  expect(entries[0]?.peer_id).toBe("peer-1");
  expect(entries[0]?.capabilities).toEqual(["app-server-ws"]);
});

test("WakeRegistry upsert de-duplicates by peer id and thread id", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();

  await registry.upsert(entry({ peer_id: "peer-1", thread_id: "thread-1", peer_name: "old" }));
  await registry.upsert(entry({ peer_id: "peer-1", thread_id: "thread-2", peer_name: "new-peer" }));
  await registry.upsert(entry({ peer_id: "peer-2", thread_id: "thread-2", peer_name: "new-thread" }));

  const entries = await registry.list({ includeStale: true });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.peer_id).toBe("peer-2");
  expect(entries[0]?.thread_id).toBe("thread-2");
});

test("WakeRegistry filters entries with stale pids", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();

  await registry.upsert(entry({ app_server_pid: 99999999 }));

  expect(await registry.list()).toEqual([]);
  const all = await registry.list({ includeStale: true });
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("stale");
});

test("WakeRegistry filters entries with stale socket paths", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();

  await registry.upsert(entry({ app_server_socket_path: join(rootDir, "missing.sock") }));

  expect(await registry.list()).toEqual([]);
  const all = await registry.list({ includeStale: true });
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("stale");
});

test.if(IS_POSIX)("WakeRegistry writes registry file at 0o600 and directory at 0o700", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();
  await registry.upsert(entry());

  const filePath = join(rootDir, "wake-registry.json");
  const fileStat = await stat(filePath);
  expect(fileStat.mode & 0o777).toBe(0o600);

  const dirStat = await stat(rootDir);
  expect(dirStat.mode & 0o777).toBe(0o700);
});

test.if(IS_POSIX)("WakeRegistry refuses to load registry file with too-wide perms", async () => {
  const rootDir = await makeDir();
  const filePath = join(rootDir, "wake-registry.json");
  await writeFile(filePath, JSON.stringify({ entries: [entry()] }), "utf8");
  await chmod(filePath, 0o644);

  const registry = new WakeRegistry({ rootDir });
  await registry.init();
  expect(await registry.list({ includeStale: true })).toEqual([]);
});

test("WakeRegistry.prune removes dead entries past the grace window, keeps live and recently-dead ones", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();
  const t0 = Date.parse("2026-06-18T00:00:00.000Z");

  // Dead (bogus pid) and last seen 60m before "now" -> past the 30m grace.
  await registry.upsert(entry({
    peer_id: "dead-old", thread_id: "t-dead-old",
    app_server_pid: 99999999, last_seen_at: new Date(t0).toISOString(),
  }));
  // Dead but last seen only 20m before "now" -> still inside the grace window.
  await registry.upsert(entry({
    peer_id: "dead-recent", thread_id: "t-dead-recent",
    app_server_pid: 99999999, last_seen_at: new Date(t0 + 40 * 60_000).toISOString(),
  }));
  // Live -> never pruned regardless of age.
  await registry.upsert(entry({
    peer_id: "live", thread_id: "t-live",
    app_server_pid: process.pid, last_seen_at: new Date(t0).toISOString(),
  }));

  const removed = await registry.prune({ deadGraceMs: 30 * 60_000, now: () => new Date(t0 + 60 * 60_000) });
  expect(removed).toBe(1);

  const ids = (await registry.list({ includeStale: true })).map((e) => e.peer_id).sort();
  expect(ids).toEqual(["dead-recent", "live"]);
});

test("hashBrokerSessionToken stores only a stable digest", () => {
  const raw = "super-secret-session-token";
  const hashed = hashBrokerSessionToken(raw);

  expect(hashed).toStartWith("sha256:");
  expect(hashed).not.toContain(raw);
  expect(hashed).toBe(hashBrokerSessionToken(raw));
});
