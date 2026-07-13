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

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_ERROR_BODY_CHARS = 2_048;

export interface BrokerHealth {
  pid: number;
}

export interface BrokerClientOptions {
  requestTimeoutMs?: number;
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
      const value = await res.json();
      return verifyHealthProof(value, sharedSecret, nonce)
        ? { pid: value.pid }
        : null;
    } catch {
      return null;
    }
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
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
      const errorBody = (await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
      throw new Error(`broker ${path}: ${res.status} ${errorBody}`);
    }
    return res.json() as Promise<T>;
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
