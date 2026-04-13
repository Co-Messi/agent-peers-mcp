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

  const header =
    `[PEER INBOX] ${messages.length} new peer message(s) — ` +
    `respond to each via send_message(to_id=<from_name>, message="...")\n`;

  const blocks = messages.map((m, i) =>
    [
      `--- msg ${i + 1} of ${messages.length} ---`,
      `message_id: ${m.id}`,
      `from: ${m.from_name} (${m.from_peer_type}, cwd=${m.from_cwd})`,
      `sent_at: ${m.sent_at}`,
      `text:`,
      m.text,
    ].join("\n")
  );

  return [header, ...blocks, "--- end peer inbox ---", ""].join("\n");
}
