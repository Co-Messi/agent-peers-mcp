export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_BROKER_RESPONSE_BYTES = 3 * 1024 * 1024;
export const MAX_HEALTH_RESPONSE_BYTES = 4 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_SUMMARY_CHARS = 1_024;
export const MAX_PATH_CHARS = 4_096;
export const MAX_TTY_CHARS = 256;
export const MAX_ID_CHARS = 128;
export const MAX_POLL_MESSAGES = 100;
export const MAX_PRESENTED_MESSAGES = 20;
export const MAX_PRESENTATION_BYTES = 256 * 1024;
export const MAX_ACK_TOKENS = 100;
export const MAX_PENDING_MESSAGES_PER_PEER = 1_000;
export const MAX_MESSAGES_PER_SENDER_PER_MINUTE = 60;
export const MAX_MESSAGES_GLOBAL_PER_MINUTE = 600;
export const MAX_RETAINED_MESSAGES = 10_000;
export const MAX_PEERS_RETURNED = 100;
export const MAX_ACTIVE_PEERS = MAX_PEERS_RETURNED;
export const MAX_RETAINED_PEERS = 1_024;
export const MAX_PEER_REGISTRATIONS_PER_MINUTE = 60;
export const PEER_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const ACKED_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
