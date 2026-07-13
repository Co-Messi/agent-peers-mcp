// shared/app-server-client.ts
// Minimal Codex app-server JSON-RPC client used by the wake daemon.

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput"> };

export interface AppServerThread {
  id: string;
  cwd: string;
  path: string | null;
  status: ThreadStatus;
}

export interface AppServerClient {
  listLoadedThreads(): Promise<string[]>;
  readThread(threadId: string): Promise<AppServerThread>;
  startWakeTurn(params: {
    threadId: string;
    clientUserMessageId: string;
    prompt: string;
    wakeId: string;
    pendingSignature: string;
  }): Promise<{ turnId: string | null }>;
  close(): void;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string } | unknown;
}

// A single wake pass talks to each peer's app-server sequentially, so any
// unbounded wait here stalls every peer behind it. Every connect and every
// request is therefore bounded; a wedged or half-dead app-server fails fast
// and the pass moves on to the next peer.
const DEFAULT_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerWsClient implements AppServerClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;

  constructor(private readonly url: string, opts: { timeoutMs?: number } = {}) {
    const parsed = new URL(url);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "ws:" || !loopback || parsed.username || parsed.password) {
      throw new Error("app-server URL must be an unauthenticated loopback ws:// URL");
    }
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("app-server timeout must be positive");
    }
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out connecting to ${this.url} after ${this.timeoutMs}ms`)), this.timeoutMs);
        ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`failed to connect to ${this.url}`)); }, { once: true });
      });
    } catch (error) {
      try { ws.close(); } catch { /* best effort */ }
      this.ws = null;
      throw error instanceof Error ? error : new Error(String(error));
    }

    ws.addEventListener("message", (event) => this.onMessage(event.data));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("app-server websocket closed"));
      }
      this.pending.clear();
    });

    try {
      await this.request("initialize", {
        clientInfo: { name: "agent-peers-wake-daemon", version: "0.1.0" },
        capabilities: {},
      });
      this.notify("initialized");
    } catch (error) {
      try { ws.close(); } catch { /* best effort */ }
      if (this.ws === ws) this.ws = null;
      throw error;
    }
  }

  async listLoadedThreads(): Promise<string[]> {
    await this.connect();
    const result = await this.request("thread/loaded/list", {});
    const data = (result as { data?: unknown }).data;
    return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : [];
  }

  async startThread(params: { cwd: string }): Promise<AppServerThread> {
    await this.connect();
    const result = await this.request("thread/start", {
      cwd: params.cwd,
    });
    const thread = (result as { thread?: AppServerThread }).thread;
    if (!thread || typeof thread.id !== "string") {
      throw new Error("thread/start returned invalid thread");
    }
    return thread;
  }

  async readThread(threadId: string): Promise<AppServerThread> {
    await this.connect();
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = (result as { thread?: AppServerThread }).thread;
    if (!thread || typeof thread.id !== "string") {
      throw new Error(`thread/read returned invalid thread for ${threadId}`);
    }
    return thread;
  }

  async startWakeTurn(params: {
    threadId: string;
    clientUserMessageId: string;
    prompt: string;
    wakeId: string;
    pendingSignature: string;
  }): Promise<{ turnId: string | null }> {
    await this.connect();
    const result = await this.request("turn/start", {
      threadId: params.threadId,
      clientUserMessageId: params.clientUserMessageId,
      input: [{ type: "text", text: params.prompt, text_elements: [] }],
    });
    const turnId = (result as { turn?: { id?: unknown } }).turn?.id;
    return { turnId: typeof turnId === "string" ? turnId : null };
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("app-server websocket is not open");
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`app-server request '${method}' timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("app-server websocket is not open");
    }
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const message = typeof msg.error === "object" && msg.error && "message" in msg.error
        ? String((msg.error as { message?: unknown }).message)
        : "app-server request failed";
      pending.reject(new Error(message));
      return;
    }
    pending.resolve(msg.result);
  }
}
