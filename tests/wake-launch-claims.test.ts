import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WakeLaunchClaimStore } from "../shared/wake-launch-claims.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-wake-claims-"));
  tempDirs.push(dir);
  return dir;
}

test("WakeLaunchClaimStore matches only ready claims for the same cwd and tty", async () => {
  const rootDir = await makeDir();
  const store = new WakeLaunchClaimStore({ rootDir });

  await store.create({ cwd: "/other", tty: "ttys001" });
  const claim = await store.create({ cwd: "/repo", tty: "ttys001", requestedPeerName: "wakee2e" });
  await store.update(claim.claim_id, {
    app_server_url: "ws://127.0.0.1:41037",
    app_server_pid: 123,
    thread_id: "thread-1",
    rollout_path: "/rollout.jsonl",
    status: "ready",
  });

  const match = await store.findMatching({ cwd: "/repo", tty: "ttys001" });
  expect(match?.claim_id).toBe(claim.claim_id);
  expect(match?.thread_id).toBe("thread-1");
  expect(await store.findMatching({ cwd: "/repo", tty: "ttys002" })).toBeNull();
});

test("WakeLaunchClaimStore waits for an in-flight matching claim to become ready", async () => {
  const rootDir = await makeDir();
  const store = new WakeLaunchClaimStore({ rootDir });
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });

  const waiting = store.findMatching({ cwd: "/repo", tty: "ttys001", waitMs: 1000 });
  await Bun.sleep(50);
  await store.update(claim.claim_id, {
    app_server_url: "ws://127.0.0.1:41037",
    app_server_pid: 123,
    thread_id: "thread-1",
    status: "ready",
  });

  expect((await waiting)?.claim_id).toBe(claim.claim_id);
});

test("WakeLaunchClaimStore does not return consumed claims", async () => {
  const rootDir = await makeDir();
  const store = new WakeLaunchClaimStore({ rootDir });
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });
  await store.update(claim.claim_id, {
    app_server_url: "ws://127.0.0.1:41037",
    app_server_pid: 123,
    thread_id: "thread-1",
    status: "ready",
  });
  await store.consume(claim.claim_id, "peer-1");

  expect(await store.findMatching({ cwd: "/repo", tty: "ttys001" })).toBeNull();
});

test("WakeLaunchClaimStore can reuse consumed claims for live remote sessions", async () => {
  const rootDir = await makeDir();
  const store = new WakeLaunchClaimStore({ rootDir });
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });
  await store.update(claim.claim_id, {
    app_server_url: "ws://127.0.0.1:41037",
    app_server_pid: process.pid,
    thread_id: "thread-1",
    rollout_path: "/rollout.jsonl",
    tui_pid: process.pid,
    status: "ready",
  });
  await store.consume(claim.claim_id, "peer-1");

  const match = await store.findMatching({
    cwd: "/repo",
    tty: "ttys001",
    waitMs: 0,
    includeConsumed: true,
    maxAgeMs: 0,
  });

  expect(match?.claim_id).toBe(claim.claim_id);
});

test("listMatchingCandidates surfaces multiple live distinct-thread claims for the same cwd/tty", async () => {
  const rootDir = await makeDir();
  const store = new WakeLaunchClaimStore({ rootDir });

  const a = await store.create({ cwd: "/repo", tty: null, requestedPeerName: "repo-codex" });
  await store.update(a.claim_id, {
    app_server_url: "ws://127.0.0.1:1", app_server_pid: process.pid, thread_id: "t-a", status: "ready",
  });
  const b = await store.create({ cwd: "/repo", tty: null, requestedPeerName: "repo-codex" });
  await store.update(b.claim_id, {
    app_server_url: "ws://127.0.0.1:2", app_server_pid: process.pid, thread_id: "t-b", status: "ready",
  });

  const candidates = await store.listMatchingCandidates({ cwd: "/repo", tty: null, includeConsumed: true });
  const liveThreads = new Set(candidates.filter((c) => c.live).map((c) => c.thread_id));
  // This is exactly the condition repair-wake refuses on: two live sessions,
  // same cwd/tty, different threads -> cannot safely guess which is which.
  expect(liveThreads.size).toBe(2);
});

test("WakeLaunchClaimStore.prune keeps live claims and removes dead, non-recent ones", async () => {
  const rootDir = await makeDir();
  const store = new WakeLaunchClaimStore({ rootDir });

  const dead = await store.create({ cwd: "/repo", tty: "ttys001" });
  await store.update(dead.claim_id, {
    app_server_url: "ws://127.0.0.1:1", app_server_pid: 99999999, thread_id: "t-dead", status: "ready",
  });
  const live = await store.create({ cwd: "/repo", tty: "ttys002" });
  await store.update(live.claim_id, {
    app_server_url: "ws://127.0.0.1:2", app_server_pid: process.pid, thread_id: "t-live", status: "ready",
  });

  // "now" an hour ahead so neither claim counts as recent — only liveness can
  // keep a claim from being reaped.
  const removed = await store.prune({ now: () => new Date(Date.now() + 60 * 60 * 1000) });
  expect(removed).toBe(1);
  expect((await store.list()).map((c) => c.claim_id)).toEqual([live.claim_id]);
});
