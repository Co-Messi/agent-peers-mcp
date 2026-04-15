import { beforeEach, expect, test } from "bun:test";
import {
  recordDelivered,
  getRecentDelivered,
  __resetRecentDeliveredForTest,
  RECENT_MAX,
  RECENT_TTL_MS,
} from "../shared/recent-delivered.ts";
import type { LeasedMessage } from "../shared/types.ts";

function makeMessage(id: number, overrides: Partial<LeasedMessage> = {}): LeasedMessage {
  return {
    id,
    from_id: `peer-${id}`,
    from_name: `peer-${id}-name`,
    from_peer_type: id % 2 === 0 ? "claude" : "codex",
    from_cwd: "/x",
    from_summary: "",
    to_id: "me",
    text: `body-${id}`,
    sent_at: "2026-04-15T00:00:00.000Z",
    lease_token: `tok-${id}`,
    ...overrides,
  };
}

beforeEach(() => __resetRecentDeliveredForTest());

test("recordDelivered + getRecentDelivered round-trip preserves order", () => {
  recordDelivered(makeMessage(1), 1_000);
  recordDelivered(makeMessage(2), 2_000);
  recordDelivered(makeMessage(3), 3_000);

  const out = getRecentDelivered(3_500);
  expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
  expect(out.map((m) => m.text)).toEqual(["body-1", "body-2", "body-3"]);
});

test("getRecentDelivered returns empty when nothing has been recorded", () => {
  expect(getRecentDelivered()).toEqual([]);
});

test("entries older than RECENT_TTL_MS are pruned on read", () => {
  const t0 = 10_000_000;
  recordDelivered(makeMessage(1), t0);
  recordDelivered(makeMessage(2), t0 + 1000);
  recordDelivered(makeMessage(3), t0 + RECENT_TTL_MS + 1);
  // Read at a time where entries 1 and 2 are > RECENT_TTL_MS old but
  // entry 3 is still fresh. cutoff = readTime - RECENT_TTL_MS.
  //   readTime = t0 + 2 * RECENT_TTL_MS → cutoff = t0 + RECENT_TTL_MS
  //   id=1 delivered at t0 → t0 < t0+TTL → PRUNED
  //   id=2 delivered at t0+1000 → t0+1000 < t0+TTL → PRUNED
  //   id=3 delivered at t0+TTL+1 → t0+TTL+1 > t0+TTL → KEPT
  const out = getRecentDelivered(t0 + 2 * RECENT_TTL_MS);
  expect(out.map((m) => m.id)).toEqual([3]);
});

test("entries older than RECENT_TTL_MS are also pruned on write", () => {
  const t0 = 5_000_000;
  recordDelivered(makeMessage(1), t0);
  // Write a new entry way in the future — previous one is now stale.
  recordDelivered(makeMessage(2), t0 + RECENT_TTL_MS + 1);
  // Read at the new now — should only have entry 2.
  const out = getRecentDelivered(t0 + RECENT_TTL_MS + 2);
  expect(out.map((m) => m.id)).toEqual([2]);
});

test("buffer is capped at RECENT_MAX, oldest evicted first", () => {
  const t0 = 1_000_000;
  for (let i = 1; i <= RECENT_MAX + 10; i++) {
    recordDelivered(makeMessage(i), t0 + i);
  }
  const out = getRecentDelivered(t0 + RECENT_MAX + 20);
  expect(out.length).toBe(RECENT_MAX);
  // The oldest 10 (ids 1..10) should have been evicted.
  expect(out[0]!.id).toBe(11);
  expect(out[out.length - 1]!.id).toBe(RECENT_MAX + 10);
});

test("duplicate message_ids are stored independently (no dedupe at this layer)", () => {
  // Dedupe is the model's responsibility (see colleague prompt). The
  // ring buffer just captures pushes; if the broker re-leases a message
  // and the push loop dedupes via the seen set BEFORE calling
  // recordDelivered, the duplicate never reaches here. But we do NOT
  // guarantee dedupe at the buffer layer — verify that.
  recordDelivered(makeMessage(42, { text: "first" }), 1000);
  recordDelivered(makeMessage(42, { text: "second" }), 2000);
  const out = getRecentDelivered(3000);
  expect(out.length).toBe(2);
  expect(out.map((m) => m.text)).toEqual(["first", "second"]);
});
