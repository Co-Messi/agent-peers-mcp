// shared/piggyback.ts
// Builds the [PEER INBOX] text block that codex-server prepends to every
// tool response to deterministically surface pending peer messages.
//
// The block is self-contained: each message includes the sender's human
// name, peer_type, cwd, and the immutable message_id, plus a reply hint.
// Codex can act on the block without reading the server's `instructions`
// field — but the instructions do strengthen the behavioral protocol, so
// the banner here is deliberately restrained: no 🚨 / caps-lock — that
// trained the model to over-react. Instead we frame each message the way
// a colleague would see a Slack DM: read, decide if it needs a reply, act
// accordingly.

import type { LeasedMessage } from "./types.ts";

// formatInboxPreview — signal-only text used by codex-server's background
// poll loop when it pushes an MCP `notifications/message` log entry.
//
// Why signal-only: the preview path can only be a nudge, not a delivery.
// We don't know whether the client surfaced the log notification to the
// model, so we cannot update dedupe state based on it. If the preview
// text included the full message body + a reply_action cue, a Codex that
// DID render the log would see both the preview AND the authoritative
// [PEER INBOX] block on the next tool call — and could reply twice. This
// string therefore carries sender identity + a pointer to where the real
// payload will appear, and nothing else.
export function formatInboxPreview(m: LeasedMessage): string {
  // Keep the tone restrained — caps-lock / "URGENT" trains the model to
  // over-react (see comment block at top of file). Clear and direct is
  // enough for the developer-role injection path.
  return (
    `New peer message from ${m.from_name} (${m.from_peer_type}). ` +
    `Call check_messages now to read and respond.`
  );
}

export function formatInboxBlock(messages: LeasedMessage[]): string {
  if (messages.length === 0) return "";

  const banner = "PEER INBOX";

  const header =
    `${banner} — ${messages.length} unread message(s) from your colleagues.\n` +
    `Read each one. Then:\n` +
    `  - If it's a question you can answer now: reply briefly via send_message(to_id="<from_name>", ...).\n` +
    `  - If it needs investigation: go investigate. Reply only when you have a real answer, a blocker, or a clarifying question.\n` +
    `  - If it's FYI: note it internally, don't auto-reply. Silence is fine.\n` +
    `  - If you disagree: push back with a specific reason.\n` +
    `Do NOT auto-acknowledge. "Got it" / "on it" is noise.`;

  const blocks = messages.map((m, i) =>
    [
      `--- message ${i + 1} of ${messages.length} ---`,
      `from: ${m.from_name} (${m.from_peer_type}, cwd=${m.from_cwd})`,
      m.from_summary ? `their current work: ${m.from_summary}` : null,
      `sent_at: ${m.sent_at}`,
      `message_id: ${m.id}`,
      `text:`,
      m.text,
      `reply_action: send_message(to_id="${m.from_name}", message="...")`,
    ].filter(Boolean).join("\n")
  );

  return [header, ...blocks, banner, ""].join("\n\n");
}
