import { expect, test } from "bun:test";
import { selectMessagesForPresentation } from "../shared/delivery-state.ts";

test("presentation batches are bounded by count and serialized bytes", () => {
  const messages = Array.from({ length: 30 }, (_, id) => ({ id, text: "x".repeat(100) }));
  expect(selectMessagesForPresentation(messages, { maxMessages: 20, maxBytes: 1_000 })).toHaveLength(8);
  expect(selectMessagesForPresentation(messages, { maxMessages: 5, maxBytes: 100_000 })).toHaveLength(5);
});
