import { test, expect } from "bun:test";
import { formatInboxBlock } from "../shared/piggyback.ts";
import type { LeasedMessage } from "../shared/types.ts";

const m = (id: number, text: string, from_name = "alpha"): LeasedMessage => ({
  id,
  from_id: "id-" + id,
  from_name,
  from_peer_type: "claude",
  from_cwd: "/x",
  from_summary: "",
  to_id: "me",
  text,
  sent_at: "2026-04-13T00:00:00.000Z",
  lease_token: "tok-" + id,
});

test("formatInboxBlock returns empty string for no messages", () => {
  expect(formatInboxBlock([])).toBe("");
});

test("formatInboxBlock carries reply hint with from_name + message_id + body", () => {
  const out = formatInboxBlock([m(42, "ping")]);
  expect(out).toContain("UNREAD PEER MESSAGES");
  expect(out).toContain("send_message(to_id=\"alpha\"");
  expect(out).toContain("message_id: 42");
  expect(out).toContain("from: alpha");
  expect(out).toContain("ping");
});

test("formatInboxBlock numbers multiple messages and emits banner twice", () => {
  const out = formatInboxBlock([m(1, "a"), m(2, "b", "beta")]);
  expect(out).toContain("message 1 of 2");
  expect(out).toContain("message 2 of 2");
  expect(out).toContain("from: alpha");
  expect(out).toContain("from: beta");
  // Banner appears at both top and bottom for summarisation resilience
  const bannerCount = (out.match(/UNREAD PEER MESSAGES/g) ?? []).length;
  expect(bannerCount).toBeGreaterThanOrEqual(2);
});
