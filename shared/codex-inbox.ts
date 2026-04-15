import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LeasedMessage, PeerId } from "./types.ts";

interface CodexInboxState {
  unread: LeasedMessage[];
}

const EMPTY_STATE: CodexInboxState = { unread: [] };

function cloneMessages(messages: LeasedMessage[]): LeasedMessage[] {
  return messages.map((message) => ({ ...message }));
}

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

async function atomicWriteJson(path: string, value: CodexInboxState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, path);
}

export class CodexInboxStore {
  private readonly filePath: string;
  private readonly persistState: (path: string, value: CodexInboxState) => Promise<void>;
  private state: CodexInboxState = { unread: [] };
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: {
    peerId: PeerId;
    rootDir?: string;
    persistState?: (path: string, value: CodexInboxState) => Promise<void>;
  }) {
    const rootDir = opts.rootDir ?? process.env.AGENT_PEERS_CODEX_STATE_DIR ?? defaultRootDir();
    const safePeerId = encodeURIComponent(opts.peerId);
    this.filePath = join(rootDir, `${safePeerId}.json`);
    this.persistState = opts.persistState ?? atomicWriteJson;
  }

  async init(): Promise<void> {
    await this.withLock(async () => {
      this.state = await this.readStateFromDisk();
    });
  }

  async getUnreadMessages(): Promise<LeasedMessage[]> {
    return this.withLock(async () => cloneMessages(this.state.unread));
  }

  async queueLeasedMessages(messages: LeasedMessage[]): Promise<void> {
    await this.withLock(async () => {
      const unreadById = new Map(this.state.unread.map((message) => [message.id, { ...message }]));
      for (const message of messages) unreadById.set(message.id, { ...message });
      const nextState = { unread: Array.from(unreadById.values()).sort((a, b) => a.id - b.id) };
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
    });
  }

  async consumeUnreadMessages(): Promise<LeasedMessage[]> {
    return this.withLock(async () => {
      const unread = cloneMessages(this.state.unread);
      const nextState = { unread: [] };
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
      return unread;
    });
  }

  async reset(): Promise<void> {
    await this.withLock(async () => {
      const nextState = { unread: [] };
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
    });
  }

  private async readStateFromDisk(): Promise<CodexInboxState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CodexInboxState>;
      if (!Array.isArray(parsed.unread)) return { unread: [] };
      return { unread: cloneMessages(parsed.unread as LeasedMessage[]) };
    } catch {
      return { unread: [] };
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export { EMPTY_STATE as EMPTY_CODEX_INBOX_STATE };
