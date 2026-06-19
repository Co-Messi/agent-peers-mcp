import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";

import { CodexInboxStore } from "../shared/codex-inbox.ts";
import type { LeasedMessage } from "../shared/types.ts";

const IS_POSIX = platform() !== "win32";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function message(id: number, overrides: Partial<LeasedMessage> = {}): LeasedMessage {
  return {
    id,
    from_id: `peer-${id}`,
    from_name: id % 2 === 0 ? "claude-peer" : "codex-peer",
    from_peer_type: id % 2 === 0 ? "claude" : "codex",
    from_cwd: `/repo-${id}`,
    from_summary: "",
    to_id: "me",
    text: `message-${id}`,
    sent_at: "2026-04-15T00:00:00.000Z",
    lease_token: `lease-${id}`,
    ...overrides,
  };
}

async function makeStore(peerId = "peer-123"): Promise<CodexInboxStore> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);
  const store = new CodexInboxStore({ peerId, rootDir: dir });
  await store.init();
  return store;
}

test("CodexInboxStore queues unread leased messages and consumes them once", async () => {
  const store = await makeStore();

  await store.queueLeasedMessages([message(1), message(2)]);
  expect(await store.getUnreadMessages()).toHaveLength(2);

  const consumed = await store.consumeUnreadMessages();
  expect(consumed.map((msg) => msg.id)).toEqual([1, 2]);
  expect(await store.getUnreadMessages()).toHaveLength(0);
});

test("CodexInboxStore de-duplicates queued messages by message id and keeps newest lease data", async () => {
  const store = await makeStore();

  await store.queueLeasedMessages([message(1), message(2)]);
  await store.queueLeasedMessages([message(2, { text: "duplicate" }), message(3)]);

  const unread = await store.getUnreadMessages();
  expect(unread.map((msg) => msg.id)).toEqual([1, 2, 3]);
  expect(unread[1]?.text).toBe("duplicate");
});

test("CodexInboxStore persists unread messages across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);

  const first = new CodexInboxStore({ peerId: "peer-123", rootDir: dir });
  await first.init();
  await first.queueLeasedMessages([message(7), message(8)]);

  const second = new CodexInboxStore({ peerId: "peer-123", rootDir: dir });
  await second.init();

  const unread = await second.getUnreadMessages();
  expect(unread.map((msg) => msg.id)).toEqual([7, 8]);
});

test("CodexInboxStore reset clears persisted unread messages", async () => {
  const store = await makeStore();

  await store.queueLeasedMessages([message(10)]);
  await store.reset();

  expect(await store.getUnreadMessages()).toHaveLength(0);
});

test("CodexInboxStore.removeByIds drops only the specified messages, keeping later arrivals", async () => {
  const store = await makeStore();
  await store.queueLeasedMessages([message(1), message(2), message(3)]);

  await store.removeByIds([1, 3]);

  const remaining = await store.getUnreadMessages();
  expect(remaining.map((m) => m.id)).toEqual([2]);
});

test("CodexInboxStore.removeByIds is a no-op when ids are already gone", async () => {
  const store = await makeStore();
  await store.queueLeasedMessages([message(5)]);

  // Remove an id that isn't in the queue — should not throw, should not
  // disturb existing state.
  await store.removeByIds([999]);

  expect((await store.getUnreadMessages()).map((m) => m.id)).toEqual([5]);
});

test("CodexInboxStore.removeByIds persists across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);

  const first = new CodexInboxStore({ peerId: "peer-123", rootDir: dir });
  await first.init();
  await first.queueLeasedMessages([message(1), message(2), message(3)]);
  await first.removeByIds([2]);

  const second = new CodexInboxStore({ peerId: "peer-123", rootDir: dir });
  await second.init();
  expect((await second.getUnreadMessages()).map((m) => m.id)).toEqual([1, 3]);
});

test("CodexInboxStore writes adjacent bodyless metadata without message bodies or lease tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);

  const store = new CodexInboxStore({ peerId: "peer-123", rootDir: dir });
  await store.init();
  await store.queueLeasedMessages([
    message(1, { text: "SECRET MESSAGE BODY", lease_token: "SECRET LEASE TOKEN" }),
  ]);

  const metadataPath = join(dir, `${encodeURIComponent("peer-123")}.metadata.json`);
  const raw = await readFile(metadataPath, "utf8");
  const parsed = JSON.parse(raw) as { unread: Array<Record<string, unknown>> };

  expect(raw).not.toContain("SECRET MESSAGE BODY");
  expect(raw).not.toContain("SECRET LEASE TOKEN");
  expect(parsed.unread).toHaveLength(1);
  expect(parsed.unread[0]?.id).toBe(1);
  expect(parsed.unread[0]).not.toHaveProperty("text");
  expect(parsed.unread[0]).not.toHaveProperty("lease_token");
});

test("CodexInboxStore metadata updates do not remove authoritative queued messages", async () => {
  const store = await makeStore("peer-meta");
  await store.queueLeasedMessages([message(1), message(2)]);

  const metadata = await store.getUnreadMessageMetadata();
  expect(metadata.map((m) => m.id)).toEqual([1, 2]);
  expect(metadata[0]).not.toHaveProperty("text");
  expect(metadata[0]).not.toHaveProperty("lease_token");

  const unread = await store.getUnreadMessages();
  expect(unread.map((m) => m.id)).toEqual([1, 2]);
  expect(unread[0]?.text).toBe("message-1");
  expect(unread[0]?.lease_token).toBe("lease-1");
});

test.if(IS_POSIX)("CodexInboxStore writes inbox file at 0o600 and directory at 0o700", async () => {
  const store = await makeStore();
  await store.queueLeasedMessages([message(1)]);

  // Walk from the inbox file back up to the tempdir looking at the immediate parent dir.
  const filePath = (store as unknown as { filePath: string }).filePath;
  const fileStat = await stat(filePath);
  expect(fileStat.mode & 0o777).toBe(0o600);

  const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
  const dirStat = await stat(dirPath);
  expect(dirStat.mode & 0o777).toBe(0o700);
});

test.if(IS_POSIX)("CodexInboxStore fails closed on an inbox file with too-wide perms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);

  // Pre-seed an inbox file with world-readable perms (what a default umask
  // would produce). A malicious local user could have planted spoofed
  // messages there; we must refuse to load instead of reading them.
  const peerId = "peer-insecure";
  const filePath = join(dir, `${encodeURIComponent(peerId)}.json`);
  await writeFile(filePath, JSON.stringify({ unread: [message(99, { text: "spoofed" })] }), "utf8");
  await chmod(filePath, 0o644); // too wide

  const store = new CodexInboxStore({ peerId, rootDir: dir });
  await expect(store.init()).rejects.toThrow(/mode|insecure/i);
});

test("CodexInboxStore keeps unread messages in memory when consume persistence fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);

  let shouldFail = false;
  const store = new CodexInboxStore({
    peerId: "peer-123",
    rootDir: dir,
    persistState: async (path, value) => {
      if (shouldFail) throw new Error("disk full");
      await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
      await chmod(path, 0o600);
    },
  });
  await store.init();
  await store.queueLeasedMessages([message(11), message(12)]);

  shouldFail = true;
  await expect(store.consumeUnreadMessages()).rejects.toThrow("disk full");

  const unread = await store.getUnreadMessages();
  expect(unread.map((msg) => msg.id)).toEqual([11, 12]);
});

test("CodexInboxStore quarantines corrupt JSON instead of silently discarding it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);
  const filePath = join(dir, "peer-corrupt.json");
  await writeFile(filePath, "{not-json", { mode: 0o600 });

  const store = new CodexInboxStore({ peerId: "peer-corrupt", rootDir: dir });
  await store.init();

  expect(await store.getUnreadMessages()).toEqual([]);
  expect((await readdir(dir)).some((name) => name.startsWith("peer-corrupt.json.corrupt-"))).toBe(true);
});

test("CodexInboxStore quarantines schema-invalid message entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);
  const filePath = join(dir, "peer-invalid.json");
  await writeFile(filePath, JSON.stringify({ version: 1, unread: [{ id: "not-a-number" }] }), { mode: 0o600 });

  const store = new CodexInboxStore({ peerId: "peer-invalid", rootDir: dir });
  await store.init();

  expect(await store.getUnreadMessages()).toEqual([]);
  expect((await readdir(dir)).some((name) => name.startsWith("peer-invalid.json.corrupt-"))).toBe(true);
});

test.if(IS_POSIX)("CodexInboxStore refuses a symlinked state directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  const target = await mkdtemp(join(tmpdir(), "agent-peers-codex-target-"));
  tempDirs.push(base, target);
  const linked = join(base, "linked");
  await symlink(target, linked, "dir");
  const store = new CodexInboxStore({ peerId: "peer-link", rootDir: linked });
  await expect(store.init()).rejects.toThrow(/symlink|directory/i);
});

test.if(IS_POSIX)("CodexInboxStore refuses a multiply-linked inbox file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);
  const target = join(dir, "target.json");
  const inbox = join(dir, "peer-hardlink.json");
  await writeFile(target, JSON.stringify({ version: 1, unread: [] }), { mode: 0o600 });
  await link(target, inbox);
  const store = new CodexInboxStore({ peerId: "peer-hardlink", rootDir: dir });
  await expect(store.init()).rejects.toThrow(/hard link|links/i);
});

test("CodexInboxStore rejects an unbounded unread queue", async () => {
  const store = await makeStore();
  await expect(store.queueLeasedMessages(
    Array.from({ length: 1_001 }, (_, i) => message(i + 1)),
  )).rejects.toThrow(/too many/i);
});

test("CodexInboxStore rejects state whose serialized bytes exceed the file limit", async () => {
  const store = await makeStore();
  const large = Array.from({ length: 140 }, (_, i) => message(i + 1, { text: "x".repeat(16 * 1024) }));
  await expect(store.queueLeasedMessages(large)).rejects.toThrow(/inbox.*large|state.*large/i);
  expect(await store.getUnreadMessages()).toEqual([]);
});

test("two store instances serialize updates and merge against durable state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(dir);
  const first = new CodexInboxStore({ peerId: "shared-peer", rootDir: dir });
  const second = new CodexInboxStore({ peerId: "shared-peer", rootDir: dir });
  await Promise.all([first.init(), second.init()]);
  await Promise.all([
    first.queueLeasedMessages([message(1)]),
    second.queueLeasedMessages([message(2)]),
  ]);
  const restarted = new CodexInboxStore({ peerId: "shared-peer", rootDir: dir });
  await restarted.init();
  expect((await restarted.getUnreadMessages()).map((m) => m.id)).toEqual([1, 2]);
});

test("file lock recovers when a live PID has been reused by another process", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "agent-peers-codex-"));
  tempDirs.push(rootDir);
  const store = new CodexInboxStore({ peerId: "pid-reuse", rootDir });
  await store.init();
  const lockPath = join(rootDir, "pid-reuse.json.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    process_start: "definitely-not-this-process",
    created_at: Date.now() - 60_000,
  }), { mode: 0o600 });
  await store.queueLeasedMessages([message(901, { text: "recovered" })]);
  expect((await store.getUnreadMessages()).map((item) => item.text)).toEqual(["recovered"]);
});
