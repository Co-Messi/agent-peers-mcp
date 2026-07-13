import type { LeasedMessage } from "./types.ts";

export interface WaitForFreshPeerMessagesOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  poll: () => Promise<void>;
  readUnread: () => Promise<LeasedMessage[]>;
  isFresh: (message: LeasedMessage) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (message: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasFreshUnread(
  queued: LeasedMessage[],
  isFresh: (message: LeasedMessage) => boolean,
): boolean {
  return queued.some(isFresh);
}

export async function waitForFreshPeerMessages(opts: WaitForFreshPeerMessagesOptions): Promise<boolean> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;

  while (true) {
    try {
      await opts.poll();
    } catch (e) {
      opts.onError?.(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      if (hasFreshUnread(await opts.readUnread(), opts.isFresh)) return true;
    } catch (e) {
      opts.onError?.(`inbox read failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(opts.pollIntervalMs, remaining));
  }
}
