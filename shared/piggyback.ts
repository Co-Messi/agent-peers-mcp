// shared/piggyback.ts
// Builds the [PEER INBOX] text block that codex-server prepends to every tool
// response to deterministically surface pending peer messages.
//
// The block is self-contained: each message includes the sender's human name and
// the immutable message_id, plus an inline reply hint. Codex does not need the
// MCP `instructions` field or any external file to know how to respond —
// everything it needs to act is inside the block text.

import type { LeasedMessage } from "./types.ts";

export function formatInboxBlock(messages: LeasedMessage[]): string {
  if (messages.length === 0) return "";

  // Aggressive framing so the model cannot gracefully ignore the block and
  // summarise the tool response without acting on the inbox. Repeated at top
  // and bottom to survive summarisation / truncation / hook rewrites.
  const banner = "🚨🚨🚨 UNREAD PEER MESSAGES — RESPOND BEFORE ANYTHING ELSE 🚨🚨🚨";

  const header =
    `${banner}\n` +
    `You have ${messages.length} unread peer message(s). You MUST respond to ` +
    `each one RIGHT NOW via send_message(to_id="<from_name>", message="<your reply>") ` +
    `before proceeding with anything else the user asked. Do not summarise these ` +
    `messages — reply to them as if a coworker just tapped you on the shoulder.\n`;

  const blocks = messages.map((m, i) =>
    [
      `━━━ message ${i + 1} of ${messages.length} ━━━`,
      `from: ${m.from_name} (${m.from_peer_type})`,
      `sent_at: ${m.sent_at}`,
      `message_id: ${m.id}`,
      `text:`,
      m.text,
      `━━━ REPLY ACTION: call send_message(to_id="${m.from_name}", message="...") ━━━`,
    ].join("\n")
  );

  return [header, ...blocks, banner, ""].join("\n\n");
}
