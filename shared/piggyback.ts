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

  const banner = "UNREAD PEER MESSAGES";

  const header =
    `${banner}\n` +
    `You have ${messages.length} unread peer message(s). Treat them like messages from a real coworker. ` +
    `Only reply when you have a substantive update to share or you need clarification to continue. ` +
    `When you do reply, use send_message(to_id="<from_name>", message="<your update or question>").\n`;

  const blocks = messages.map((m, i) =>
    [
      `message ${i + 1} of ${messages.length}`,
      `from: ${m.from_name} (${m.from_peer_type}, cwd=${m.from_cwd})`,
      `sent_at: ${m.sent_at}`,
      `message_id: ${m.id}`,
      `text:`,
      m.text,
      `reply_action: send_message(to_id="${m.from_name}", message="...")`,
    ].join("\n")
  );

  return [header, ...blocks, banner, ""].join("\n\n");
}
