export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error("invalid agent-peers port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("agent-peers port must be between 1024 and 65535");
  }
  return port;
}
