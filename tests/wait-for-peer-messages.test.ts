import { expect, test } from "bun:test";

import {
  hasFreshUnread,
  waitForFreshPeerMessages,
} from "../shared/wait-for-peer-messages.ts";
import type { LeasedMessage } from "../shared/types.ts";

function message(id: number): LeasedMessage {
  return {
    id,
    from_id: `from-${id}`,
    from_name: `peer-${id}`,
    from_peer_type: "claude",
    from_cwd: "/repo",
    from_summary: "",
    to_id: "me",
    text: `body-${id}`,
    sent_at: "2026-06-18T00:00:00.000Z",
    lease_token: `lease-${id}`,
  };
}

test("hasFreshUnread ignores messages filtered by the dedupe callback", () => {
  expect(hasFreshUnread([message(1), message(2)], (m) => m.id === 2)).toBe(true);
  expect(hasFreshUnread([message(1), message(2)], () => false)).toBe(false);
});

test("waitForFreshPeerMessages returns immediately when poll queues a fresh message", async () => {
  const unread: LeasedMessage[] = [];
  let polls = 0;

  const found = await waitForFreshPeerMessages({
    timeoutMs: 1000,
    pollIntervalMs: 100,
    poll: async () => {
      polls += 1;
      unread.push(message(10));
    },
    readUnread: async () => unread,
    isFresh: () => true,
    sleep: async () => {
      throw new Error("should not sleep when fresh message is present");
    },
  });

  expect(found).toBe(true);
  expect(polls).toBe(1);
});

test("waitForFreshPeerMessages waits until a later poll queues a fresh message", async () => {
  const unread: LeasedMessage[] = [];
  let polls = 0;
  let clock = 0;
  const sleeps: number[] = [];

  const found = await waitForFreshPeerMessages({
    timeoutMs: 1000,
    pollIntervalMs: 100,
    poll: async () => {
      polls += 1;
      if (polls === 3) unread.push(message(30));
    },
    readUnread: async () => unread,
    isFresh: () => true,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  expect(found).toBe(true);
  expect(polls).toBe(3);
  expect(sleeps).toEqual([100, 100]);
});

test("waitForFreshPeerMessages returns false on timeout without a fresh message", async () => {
  let clock = 0;
  let polls = 0;

  const found = await waitForFreshPeerMessages({
    timeoutMs: 250,
    pollIntervalMs: 100,
    poll: async () => {
      polls += 1;
    },
    readUnread: async () => [],
    isFresh: () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  expect(found).toBe(false);
  expect(polls).toBe(4);
});

test("waitForFreshPeerMessages tolerates transient poll and read errors", async () => {
  const unread: LeasedMessage[] = [];
  const errors: string[] = [];
  let polls = 0;
  let reads = 0;
  let clock = 0;

  const found = await waitForFreshPeerMessages({
    timeoutMs: 1000,
    pollIntervalMs: 100,
    poll: async () => {
      polls += 1;
      if (polls === 1) throw new Error("broker down");
      if (polls === 3) unread.push(message(40));
    },
    readUnread: async () => {
      reads += 1;
      if (reads === 1) throw new Error("disk busy");
      return unread;
    },
    isFresh: () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onError: (message) => errors.push(message),
  });

  expect(found).toBe(true);
  expect(errors).toEqual(["poll failed: broker down", "inbox read failed: disk busy"]);
});
