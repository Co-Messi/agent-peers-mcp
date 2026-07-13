import { MAX_ACK_TOKENS } from "./limits.ts";
import type { LeasedMessage } from "./types.ts";

interface DurableInbox {
  getUnreadMessages(): Promise<LeasedMessage[]>;
  removeByIds(ids: number[]): Promise<void>;
}

export interface ExplicitAckResult {
  acknowledged_ids: number[];
  missing_ids: number[];
  broker_acked: number;
  broker_error?: string;
}

export function parseExplicitAckIds(value: unknown): number[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message_ids must be a non-empty array");
  }
  const ids = (value as { message_ids?: unknown }).message_ids;
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("message_ids must be a non-empty array");
  if (ids.length > MAX_ACK_TOKENS) throw new Error("too many message_ids");
  if (!ids.every((id) => Number.isSafeInteger(id) && (id as number) > 0)) {
    throw new Error("message_ids must contain positive integers");
  }
  return [...new Set(ids as number[])];
}

export async function acknowledgeDurableMessages(opts: {
  store: DurableInbox;
  messageIds: number[];
  maxBatchSize: number;
  ackBroker: (leaseTokens: string[]) => Promise<string[]>;
}): Promise<ExplicitAckResult> {
  if (!Number.isSafeInteger(opts.maxBatchSize) || opts.maxBatchSize <= 0) {
    throw new Error("maxBatchSize must be a positive integer");
  }
  const requested = new Set(opts.messageIds);
  const unread = await opts.store.getUnreadMessages();
  const matched = unread.filter((message) => requested.has(message.id));
  const matchedIds = matched.map((message) => message.id);
  const matchedSet = new Set(matchedIds);
  const missingIds = opts.messageIds.filter((id) => !matchedSet.has(id));

  // The explicit tool invocation is the model-delivery evidence. Remove the
  // local copy first; if broker acknowledgement then fails, its lease expires
  // and the broker safely re-delivers a duplicate instead of losing the mail.
  await opts.store.removeByIds(matchedIds);

  let brokerAcked = 0;
  try {
    for (let i = 0; i < matched.length; i += opts.maxBatchSize) {
      const tokens = matched.slice(i, i + opts.maxBatchSize).map((message) => message.lease_token);
      brokerAcked += (await opts.ackBroker(tokens)).length;
    }
  } catch (error) {
    return {
      acknowledged_ids: matchedIds,
      missing_ids: missingIds,
      broker_acked: brokerAcked,
      broker_error: error instanceof Error ? error.message : String(error),
    };
  }
  return { acknowledged_ids: matchedIds, missing_ids: missingIds, broker_acked: brokerAcked };
}
