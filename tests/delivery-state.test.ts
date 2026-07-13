import { expect, test } from "bun:test";
import { PendingAckQueue } from "../shared/delivery-state.ts";

test("PendingAckQueue keeps only the newest lease token per message", () => {
  const queue = new PendingAckQueue(100);
  queue.enqueue(1, "old");
  queue.enqueue(1, "new");
  expect(queue.nextBatch()).toEqual([{ messageId: 1, token: "new" }]);
});

test("PendingAckQueue batches without dropping unflushed messages", () => {
  const queue = new PendingAckQueue(100);
  for (let i = 1; i <= 250; i++) queue.enqueue(i, `token-${i}`);
  const first = queue.nextBatch();
  expect(first).toHaveLength(100);
  queue.confirm(first);
  expect(queue.size).toBe(150);
  expect(queue.nextBatch()).toHaveLength(100);
});

test("PendingAckQueue confirmation cannot delete a newer replacement token", () => {
  const queue = new PendingAckQueue(100);
  queue.enqueue(1, "old");
  const batch = queue.nextBatch();
  queue.enqueue(1, "new");
  queue.confirm(batch);
  expect(queue.nextBatch()).toEqual([{ messageId: 1, token: "new" }]);
});
