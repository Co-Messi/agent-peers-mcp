export function selectMessagesForPresentation<T>(
  messages: T[],
  limits: { maxMessages: number; maxBytes: number },
): T[] {
  const selected: T[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const message of messages) {
    if (selected.length >= limits.maxMessages) break;
    const size = encoder.encode(JSON.stringify(message)).byteLength;
    if (bytes + size > limits.maxBytes) break;
    selected.push(message);
    bytes += size;
  }
  return selected;
}
