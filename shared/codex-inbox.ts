// shared/codex-inbox.ts
// Durable on-disk queue of unread peer messages for a Codex session. Lives
// at ~/.agent-peers-codex/<peer-id>.json (overridable via
// AGENT_PEERS_CODEX_STATE_DIR) and survives MCP process restarts within the
// 60s reclaim window.
//
// SECURITY INVARIANT: this file mirrors the broker's SQLite trust boundary.
// Message bodies here are identical to rows in ~/.agent-peers.db, which the
// broker hardens to 0o600 via multiple audit rounds (see broker.ts
// enforceDbFilePerms). We enforce the same invariant here:
//   - directory created with mode 0o700 and chmod re-applied defensively
//   - file written with mode 0o600 (temp file + rename preserves perms)
//   - on read, we stat the file and refuse to load it if perms are wider
//     than 0o600 (fail closed — don't silently serve a leak)
// Only POSIX platforms get the perm enforcement; on Windows we skip it.

import { mkdir, readFile, rename, writeFile, chmod, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import type { LeasedMessage, PeerId } from "./types.ts";

interface CodexInboxState {
  unread: LeasedMessage[];
}

const EMPTY_STATE: CodexInboxState = { unread: [] };
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IS_POSIX = platform() !== "win32";

function cloneMessages(messages: LeasedMessage[]): LeasedMessage[] {
  return messages.map((message) => ({ ...message }));
}

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

async function atomicWriteJson(path: string, value: CodexInboxState): Promise<void> {
  const dir = dirname(path);
  // Create the dir with 0o700 and re-chmod defensively — mkdir's mode can be
  // masked by umask on some Node/Bun versions, so we always follow up with
  // an explicit chmod to close the window.
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (IS_POSIX) {
    try { await chmod(dir, DIR_MODE); } catch { /* best effort */ }
  }

  const tempPath = `${path}.tmp`;
  // writeFile with `mode` only takes effect on file creation; if the temp
  // file already exists from a crashed prior write, the mode is ignored —
  // we chmod explicitly right after to guarantee the invariant.
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE });
  if (IS_POSIX) {
    try { await chmod(tempPath, FILE_MODE); } catch { /* best effort */ }
  }

  // rename is atomic on the same filesystem and preserves the 0o600 mode
  // we just set. If the destination already existed with wider perms, the
  // rename replaces it wholesale.
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

  // Remove specific messages by id, atomically. Used by the "confirm on
  // next tool call" flow in codex-server.ts: when the NEXT call fires we
  // know the PREVIOUS response cycle completed, so messages drawn into
  // that response can finally be pruned from the durable queue. A plain
  // consumeUnreadMessages() would drop EVERYTHING including messages that
  // arrived between the last draw and this call — which must stay queued.
  async removeByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.withLock(async () => {
      const drop = new Set(ids);
      const nextState = {
        unread: this.state.unread.filter((m) => !drop.has(m.id)),
      };
      // Only write if something actually changed — avoids a write storm
      // when removeByIds is called with ids that are no longer in the
      // queue (harmless but noisy in tests).
      if (nextState.unread.length === this.state.unread.length) return;
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
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
      // Fail-closed perm check (matches broker.ts enforceDbFilePerms). If
      // the file exists with perms wider than 0o600 or owned by another
      // user, refuse to read it — another local user may have stuffed
      // crafted messages in to spoof peer identities, or may be reading
      // our message bodies. We return empty state rather than throwing so
      // the session still starts cleanly; the operator will see the
      // refusal in stderr and can investigate.
      if (IS_POSIX) {
        const st = await stat(this.filePath);
        if (!st.isFile()) {
          console.error(
            `[agent-peers/codex-inbox] ${this.filePath} is not a regular file — refusing to load; starting with empty inbox`,
          );
          return { unread: [] };
        }
        const mine = (process as unknown as { getuid?: () => number }).getuid?.();
        if (typeof mine === "number" && st.uid !== mine) {
          console.error(
            `[agent-peers/codex-inbox] ${this.filePath} owned by uid ${st.uid}, not ${mine} — refusing to load; starting with empty inbox`,
          );
          return { unread: [] };
        }
        const mode = st.mode & 0o777;
        if (mode !== FILE_MODE) {
          console.error(
            `[agent-peers/codex-inbox] ${this.filePath} has mode ${mode.toString(8)}, expected 0600 — refusing to load; starting with empty inbox`,
          );
          return { unread: [] };
        }
      }

      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CodexInboxState>;
      if (!Array.isArray(parsed.unread)) return { unread: [] };
      return { unread: cloneMessages(parsed.unread as LeasedMessage[]) };
    } catch {
      // File doesn't exist yet (common on first boot) or JSON parse failed.
      // Either way: start empty. stat() throws ENOENT before we can
      // distinguish, so we can't narrow here without double-statting.
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
