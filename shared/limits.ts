export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_SUMMARY_CHARS = 1_024;
export const MAX_PATH_CHARS = 4_096;
export const MAX_TTY_CHARS = 256;
export const MAX_ID_CHARS = 128;
export const MAX_POLL_MESSAGES = 100;
export const MAX_ACK_TOKENS = 100;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
