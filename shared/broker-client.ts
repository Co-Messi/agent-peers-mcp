// shared/broker-client.ts
// Typed HTTP wrapper around the broker. Used by both MCP servers and cli.ts.

import type {
  RegisterRequest, RegisterResponse, SetSummaryRequest, ListPeersRequest,
  SendMessageRequest, SendMessageResponse, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
  HeartbeatRequest, UnregisterRequest, PollMessagesRequest,
  LeasedMessage, Peer, BrokerDiagnostics,
} from "./types.ts";
import { createHealthNonce, verifyHealthProof } from "./broker-auth.ts";
import { MAX_BROKER_RESPONSE_BYTES, MAX_HEALTH_RESPONSE_BYTES } from "./limits.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_ERROR_BODY_CHARS = 2_048;

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("broker response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  return JSON.parse(await readBoundedText(response, maxBytes)) as T;
}

export interface BrokerHealth {
  pid: number;
}

export interface BrokerClientOptions {
  requestTimeoutMs?: number;
}

export class BrokerHttpError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`broker ${path}: HTTP ${status}`);
    this.name = "BrokerHttpError";
  }
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof BrokerHttpError && error.status === 401;
}

export interface BrokerClient {
  isAlive(): Promise<boolean>;
  health(): Promise<BrokerHealth | null>;
  register(req: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(req: HeartbeatRequest): Promise<void>;
  unregister(req: UnregisterRequest): Promise<void>;
  setSummary(req: SetSummaryRequest): Promise<void>;
  listPeers(req: ListPeersRequest): Promise<Peer[]>;
  sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  pollMessages(req: PollMessagesRequest): Promise<LeasedMessage[]>;
  ackMessages(req: AckMessagesRequest): Promise<AckMessagesResponse>;
  renamePeer(req: RenamePeerRequest): Promise<RenamePeerResponse>;
  diagnostics(): Promise<BrokerDiagnostics>;
  // Note: there is no adminRenamePeer() in the client anymore. cli.ts reads
  // the target peer's session_token from SQLite directly and calls renamePeer
  // with it — see cli.ts cmdRename.
}

export const SECRET_HEADER = "X-Agent-Peers-Secret";

export function createClient(
  baseUrl: string,
  sharedSecret: string,
  options: BrokerClientOptions = {},
): BrokerClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function health(): Promise<BrokerHealth | null> {
    const nonce = createHealthNonce();
    try {
      const url = new URL("/health", baseUrl);
      url.searchParams.set("nonce", nonce);
      const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!res.ok) return null;
      const value = await readBoundedJson<unknown>(res, MAX_HEALTH_RESPONSE_BYTES);
      return verifyHealthProof(value, sharedSecret, nonce)
        ? { pid: value.pid }
        : null;
    } catch {
      return null;
    }
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    // Never transmit the root credential to a service that has not just
    // proved knowledge of it through the nonce-bound HMAC health challenge.
    // This check applies to every POST, including CLI commands that do not run
    // the MCP startup lifecycle first.
    if (!(await health())) throw new Error("broker identity verification failed");
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SECRET_HEADER]: sharedSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!res.ok) {
      const errorBody = (await readBoundedText(res, MAX_ERROR_BODY_CHARS)).slice(0, MAX_ERROR_BODY_CHARS);
      void errorBody; // read a bounded amount so the connection can be reused
      throw new BrokerHttpError(path, res.status);
    }
    return readBoundedJson<T>(res, MAX_BROKER_RESPONSE_BYTES);
  }

  return {
    health,
    async isAlive() { return (await health()) !== null; },
    register(req) { return post<RegisterResponse>("/register", req); },
    async heartbeat(req) { await post("/heartbeat", req); },
    async unregister(req) { await post("/unregister", req); },
    async setSummary(req) { await post("/set-summary", req); },
    listPeers(req) { return post<Peer[]>("/list-peers", req); },
    sendMessage(req) { return post<SendMessageResponse>("/send-message", req); },
    async pollMessages(req) {
      const { messages } = await post<{ messages: LeasedMessage[] }>("/poll-messages", req);
      return messages;
    },
    ackMessages(req) { return post<AckMessagesResponse>("/ack-messages", req); },
    renamePeer(req) { return post<RenamePeerResponse>("/rename-peer", req); },
    diagnostics() { return post<BrokerDiagnostics>("/diagnostics", {}); },
  };
}
