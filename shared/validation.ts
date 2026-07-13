import { isValidName } from "./names.ts";
import {
  MAX_ACK_TOKENS,
  MAX_ID_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_PATH_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TTY_CHARS,
  utf8ByteLength,
} from "./limits.ts";
import type {
  AckMessagesRequest,
  HeartbeatRequest,
  ListPeersRequest,
  PollMessagesRequest,
  RegisterRequest,
  RenamePeerRequest,
  SendMessageRequest,
  SetSummaryRequest,
  UnregisterRequest,
} from "./types.ts";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  if (!allowEmpty && value.length === 0) throw new ValidationError(`${field} must not be empty`);
  if (value.length > maxChars) throw new ValidationError(`${field} is too long`);
  return value;
}

function nullableString(value: unknown, field: string, maxChars: number): string | null {
  return value === null ? null : string(value, field, maxChars, true);
}

function id(value: unknown, field: string): string {
  return string(value, field, MAX_ID_CHARS);
}

function session(value: unknown): string {
  return string(value, "session_token", MAX_ID_CHARS);
}

export function assertMessageText(value: unknown): string {
  const text = string(value, "message", MAX_MESSAGE_BYTES);
  if (utf8ByteLength(text) > MAX_MESSAGE_BYTES) throw new ValidationError("message is too long");
  return text;
}

export function assertSummary(value: unknown): string {
  return string(value, "summary", MAX_SUMMARY_CHARS, true);
}

export function parseRegisterRequest(value: unknown): RegisterRequest {
  const r = record(value);
  if (r.peer_type !== "claude" && r.peer_type !== "codex") {
    throw new ValidationError("peer_type must be claude or codex");
  }
  if (!Number.isSafeInteger(r.pid) || (r.pid as number) <= 0) {
    throw new ValidationError("pid must be a positive integer");
  }
  let name: string | undefined;
  if (r.name !== undefined) {
    name = string(r.name, "name", 32);
    if (!isValidName(name)) throw new ValidationError("invalid name");
  }
  return {
    peer_type: r.peer_type,
    pid: r.pid as number,
    cwd: string(r.cwd, "cwd", MAX_PATH_CHARS),
    git_root: nullableString(r.git_root, "git_root", MAX_PATH_CHARS),
    tty: nullableString(r.tty, "tty", MAX_TTY_CHARS),
    summary: assertSummary(r.summary),
    ...(r.reclaim_token === undefined ? {} : { reclaim_token: id(r.reclaim_token, "reclaim_token") }),
    ...(name ? { name } : {}),
  };
}

export function parseHeartbeatRequest(value: unknown): HeartbeatRequest {
  const r = record(value);
  return { id: id(r.id, "id"), session_token: session(r.session_token) };
}

export const parseUnregisterRequest = parseHeartbeatRequest as (value: unknown) => UnregisterRequest;
export const parsePollMessagesRequest = parseHeartbeatRequest as (value: unknown) => PollMessagesRequest;

export function parseSetSummaryRequest(value: unknown): SetSummaryRequest {
  const r = record(value);
  return { id: id(r.id, "id"), session_token: session(r.session_token), summary: assertSummary(r.summary) };
}

export function parseListPeersRequest(value: unknown): ListPeersRequest {
  const r = record(value);
  if (r.scope !== "machine" && r.scope !== "directory" && r.scope !== "repo") {
    throw new ValidationError("invalid scope");
  }
  if (r.peer_type !== undefined && r.peer_type !== "claude" && r.peer_type !== "codex") {
    throw new ValidationError("invalid peer_type");
  }
  return {
    scope: r.scope,
    cwd: string(r.cwd, "cwd", MAX_PATH_CHARS),
    git_root: nullableString(r.git_root, "git_root", MAX_PATH_CHARS),
    ...(r.exclude_id === undefined ? {} : { exclude_id: id(r.exclude_id, "exclude_id") }),
    ...(r.peer_type === undefined ? {} : { peer_type: r.peer_type }),
  };
}

export function parseSendMessageRequest(value: unknown): SendMessageRequest {
  const r = record(value);
  return {
    from_id: id(r.from_id, "from_id"),
    session_token: session(r.session_token),
    to_id_or_name: id(r.to_id_or_name, "to_id_or_name"),
    text: assertMessageText(r.text),
  };
}

export function parseAckMessagesRequest(value: unknown): AckMessagesRequest {
  const r = record(value);
  if (!Array.isArray(r.lease_tokens)) throw new ValidationError("lease_tokens must be an array");
  if (r.lease_tokens.length > MAX_ACK_TOKENS) throw new ValidationError("too many lease tokens");
  return {
    id: id(r.id, "id"),
    session_token: session(r.session_token),
    lease_tokens: r.lease_tokens.map((token) => id(token, "lease_token")),
  };
}

export function parseRenamePeerRequest(value: unknown): RenamePeerRequest {
  const r = record(value);
  const newName = string(r.new_name, "new_name", 32);
  if (!isValidName(newName)) throw new ValidationError("invalid name");
  return { id: id(r.id, "id"), session_token: session(r.session_token), new_name: newName };
}

export function parseListPeersToolArgs(value: unknown): Pick<ListPeersRequest, "scope" | "peer_type"> {
  const r = record(value);
  if (r.scope !== "machine" && r.scope !== "directory" && r.scope !== "repo") {
    throw new ValidationError("invalid scope");
  }
  if (r.peer_type !== undefined && r.peer_type !== "claude" && r.peer_type !== "codex") {
    throw new ValidationError("invalid peer_type");
  }
  return { scope: r.scope, ...(r.peer_type === undefined ? {} : { peer_type: r.peer_type }) };
}

export function parseSendMessageToolArgs(value: unknown): { to_id: string; message: string } {
  const r = record(value);
  return { to_id: id(r.to_id, "to_id"), message: assertMessageText(r.message) };
}

export function parseSetSummaryToolArgs(value: unknown): { summary: string } {
  return { summary: assertSummary(record(value).summary) };
}

export function parseRenameToolArgs(value: unknown): { new_name: string } {
  const newName = string(record(value).new_name, "new_name", 32);
  if (!isValidName(newName)) throw new ValidationError("invalid name");
  return { new_name: newName };
}
