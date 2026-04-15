import { test, expect } from "bun:test";
import { formatInboxBlock } from "../shared/piggyback.ts";
import type { LeasedMessage } from "../shared/types.ts";

const m = (id: number, text: string, from_name = "alpha", from_summary = ""): LeasedMessage => ({
  id,
  from_id: "id-" + id,
  from_name,
  from_peer_type: "claude",
  from_cwd: "/x",
  from_summary,
  to_id: "me",
  text,
  sent_at: "2026-04-13T00:00:00.000Z",
  lease_token: "tok-" + id,
});

test("formatInboxBlock returns empty string for no messages", () => {
  expect(formatInboxBlock([])).toBe("");
});

test("formatInboxBlock carries sender identity, colleague framing, and reply guidance", () => {
  const out = formatInboxBlock([m(42, "ping")]);
  // Colleague-tone banner (no more 🚨 / caps-lock flailing).
  expect(out).toContain("PEER INBOX");
  expect(out).toContain("from your colleagues");
  // Full sender identity.
  expect(out).toContain("from: alpha (claude");
  expect(out).toContain("cwd=/x");
  // Unique message id for dedupe + reply referencing.
  expect(out).toContain("message_id: 42");
  // Behavioral rules — each of the four reaction paths must be present.
  expect(out).toContain("answer now"); // question path
  expect(out).toContain("investigate"); // investigate path
  expect(out).toContain("FYI"); // info-only path
  expect(out).toContain("disagree"); // pushback path
  // Anti-pattern explicitly forbidden.
  expect(out).toContain("auto-acknowledge");
  // Body text preserved verbatim.
  expect(out).toContain("ping");
  // Reply action hint.
  expect(out).toContain("send_message(to_id=\"alpha\"");
});

test("formatInboxBlock includes sender summary when provided", () => {
  const out = formatInboxBlock([m(1, "hi", "backend-codex", "refactoring auth middleware")]);
  expect(out).toContain("their current work: refactoring auth middleware");
});

test("formatInboxBlock omits summary line when sender has no summary", () => {
  const out = formatInboxBlock([m(1, "hi", "backend-codex", "")]);
  expect(out).not.toContain("their current work:");
});

test("formatInboxBlock numbers multiple messages and repeats the banner at head + foot", () => {
  const out = formatInboxBlock([m(1, "a"), m(2, "b", "beta")]);
  expect(out).toContain("message 1 of 2");
  expect(out).toContain("message 2 of 2");
  expect(out).toContain("send_message(to_id=\"alpha\"");
  expect(out).toContain("send_message(to_id=\"beta\"");
  // Banner present at top AND bottom for summarization resilience.
  const bannerCount = (out.match(/PEER INBOX/g) ?? []).length;
  expect(bannerCount).toBeGreaterThanOrEqual(2);
});
