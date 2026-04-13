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

test("formatInboxBlock includes reply hint with from_name + message_id + body", () => {
  const out = formatInboxBlock([m(42, "ping")]);
  expect(out).toContain("[PEER INBOX]");
  expect(out).toContain("respond to each via send_message");
  expect(out).toContain("message_id: 42");
  expect(out).toContain("from: alpha");
  expect(out).toContain("ping");
});

test("formatInboxBlock numbers multiple messages", () => {
  const out = formatInboxBlock([m(1, "a"), m(2, "b", "beta")]);
  expect(out).toContain("msg 1 of 2");
  expect(out).toContain("msg 2 of 2");
  expect(out).toContain("from: alpha");
  expect(out).toContain("from: beta");
});
