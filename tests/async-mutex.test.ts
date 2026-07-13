import { expect, test } from "bun:test";

import { AsyncMutex } from "../shared/async-mutex.ts";

test("AsyncMutex serializes overlapping operations and releases after failure", async () => {
  const mutex = new AsyncMutex();
  const events: string[] = [];

  const first = mutex.runExclusive(async () => {
    events.push("first:start");
    await Bun.sleep(10);
    events.push("first:end");
    throw new Error("expected");
  });
  const second = mutex.runExclusive(async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await expect(first).rejects.toThrow("expected");
  await second;
  expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
});
