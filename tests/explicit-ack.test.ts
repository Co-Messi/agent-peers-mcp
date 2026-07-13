import { expect, test } from "bun:test";

import { acknowledgeDurableMessages, parseExplicitAckIds } from "../shared/explicit-ack.ts";
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
    text: `message-${id}`,
    sent_at: "2026-07-13T00:00:00.000Z",
    lease_token: `lease-${id}`,
  };
}

test("explicit acknowledgement removes only requested durable messages", async () => {
  let unread = [message(1), message(2), message(3)];
  const batches: string[][] = [];
  const result = await acknowledgeDurableMessages({
    store: {
      getUnreadMessages: async () => unread.map((item) => ({ ...item })),
      removeByIds: async (ids) => { unread = unread.filter((item) => !ids.includes(item.id)); },
    },
    messageIds: [1, 3],
    maxBatchSize: 100,
    ackBroker: async (tokens) => { batches.push(tokens); return tokens; },
  });
  expect(unread.map((item) => item.id)).toEqual([2]);
  expect(batches).toEqual([["lease-1", "lease-3"]]);
  expect(result).toEqual({ acknowledged_ids: [1, 3], missing_ids: [], broker_acked: 2 });
});

test("broker acknowledgement failure cannot erase delivery evidence before explicit model ack", async () => {
  let unread = [message(7)];
  const result = await acknowledgeDurableMessages({
    store: {
      getUnreadMessages: async () => unread,
      removeByIds: async (ids) => { unread = unread.filter((item) => !ids.includes(item.id)); },
    },
    messageIds: [7],
    maxBatchSize: 100,
    ackBroker: async () => { throw new Error("broker unavailable"); },
  });
  // The explicit tool call is the delivery evidence, so local removal is safe.
  // The unacked broker lease will re-deliver later, producing a safe duplicate.
  expect(unread).toEqual([]);
  expect(result.acknowledged_ids).toEqual([7]);
  expect(result.broker_acked).toBe(0);
  expect(result.broker_error).toMatch(/unavailable/);
});

test("unknown acknowledgement IDs are reported without touching the broker", async () => {
  let brokerCalls = 0;
  const result = await acknowledgeDurableMessages({
    store: {
      getUnreadMessages: async () => [message(4)],
      removeByIds: async (ids) => { expect(ids).toEqual([]); },
    },
    messageIds: [99],
    maxBatchSize: 100,
    ackBroker: async () => { brokerCalls += 1; return []; },
  });
  expect(result).toEqual({ acknowledged_ids: [], missing_ids: [99], broker_acked: 0 });
  expect(brokerCalls).toBe(0);
});

test("explicit acknowledgement parser rejects malformed or oversized ids", () => {
  expect(parseExplicitAckIds({ message_ids: [3, 1, 3] })).toEqual([3, 1]);
  expect(() => parseExplicitAckIds({ message_ids: [] })).toThrow(/message_ids/i);
  expect(() => parseExplicitAckIds({ message_ids: [0] })).toThrow(/message_ids/i);
  expect(() => parseExplicitAckIds({ message_ids: [1.5] })).toThrow(/message_ids/i);
  expect(() => parseExplicitAckIds({ message_ids: Array.from({ length: 101 }, (_, i) => i + 1) })).toThrow(/too many/i);
});

test("explicit acknowledgement rejects an invalid broker batch size", async () => {
  await expect(acknowledgeDurableMessages({
    store: { getUnreadMessages: async () => [], removeByIds: async () => {} },
    messageIds: [1],
    maxBatchSize: 0,
    ackBroker: async (tokens) => tokens,
  })).rejects.toThrow(/maxBatchSize/i);
});
