// shared/types.ts
// Canonical types used by broker, clients, and CLI.

export type PeerId = string; // UUID v4
export type PeerType = "claude" | "codex";
export type PeerName = string; // 1-32 chars, ^[a-zA-Z0-9_-]+$

export interface Peer {
  id: PeerId;
  name: PeerName;
  peer_type: PeerType;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface LeasedMessage {
  id: number;
  from_id: PeerId;
  from_name: PeerName;
  from_peer_type: PeerType;
  from_cwd: string;
  from_summary: string;
  to_id: PeerId;
  text: string;
  sent_at: string;
  lease_token: string;
}

// ----- Broker API request/response -----

export interface RegisterRequest {
  peer_type: PeerType;
  name?: PeerName;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  name: PeerName;
  session_token: string; // opaque per-session auth token; required on peer mutations
}

export interface HeartbeatRequest { id: PeerId; session_token: string; }

export interface UnregisterRequest { id: PeerId; session_token: string; }

export interface SetSummaryRequest { id: PeerId; session_token: string; summary: string; }

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  peer_type?: PeerType;
}

export interface SendMessageRequest {
  from_id: PeerId;
  session_token: string;
  to_id_or_name: string;
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message_id?: number;
}

export interface PollMessagesRequest { id: PeerId; session_token: string; }

export interface PollMessagesResponse {
  messages: LeasedMessage[];
}

export interface AckMessagesRequest {
  id: PeerId;
  session_token: string;
  lease_tokens: string[];
}

export interface AckMessagesResponse {
  ok: boolean;
  acked: number;
}

export interface RenamePeerRequest {
  id: PeerId;
  session_token: string;
  new_name: PeerName;
}

export interface RenamePeerResponse {
  ok: boolean;
  error?: string;
  name?: PeerName;
}
