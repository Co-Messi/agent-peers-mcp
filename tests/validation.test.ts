import { expect, test } from "bun:test";
import {
  parseAckMessagesRequest,
  parseListPeersToolArgs,
  parseRegisterRequest,
  parseSendMessageToolArgs,
} from "../shared/validation.ts";

test("registration parser rejects missing and malformed runtime fields", () => {
  expect(() => parseRegisterRequest({})).toThrow(/peer_type/);
  expect(() => parseRegisterRequest({
    peer_type: "other", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "",
  })).toThrow(/peer_type/);
  expect(() => parseRegisterRequest({
    peer_type: "claude", pid: 0, cwd: "/x", git_root: null, tty: null, summary: "",
  })).toThrow(/pid/);
});

test("MCP tool parsers reject invalid scopes and oversized messages", () => {
  expect(() => parseListPeersToolArgs({ scope: "planet" })).toThrow(/scope/);
  expect(() => parseSendMessageToolArgs({ to_id: "peer", message: "x".repeat(16 * 1024 + 1) }))
    .toThrow(/too long/);
});

test("ack parser bounds the token batch", () => {
  expect(() => parseAckMessagesRequest({
    id: "peer",
    session_token: "session",
    lease_tokens: Array.from({ length: 101 }, () => "lease"),
  })).toThrow(/too many/);
});
