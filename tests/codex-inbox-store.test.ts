import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

test.if(IS_POSIX)("CodexInboxStore refuses to load an inbox file with too-wide perms", async () => {
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
  await store.init();
  const unread = await store.getUnreadMessages();

  // Fail-closed: we got an empty inbox instead of the attacker-controlled payload.
  expect(unread).toEqual([]);
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
      const writer = Bun.file(path);
      await Bun.write(writer, JSON.stringify(value, null, 2));
    },
  });
  await store.init();
  await store.queueLeasedMessages([message(11), message(12)]);

  shouldFail = true;
  await expect(store.consumeUnreadMessages()).rejects.toThrow("disk full");

  const unread = await store.getUnreadMessages();
  expect(unread.map((msg) => msg.id)).toEqual([11, 12]);
});
