import { expect, test } from "bun:test";
import type { ThreadStatus } from "../shared/app-server-client.ts";

import {
  buildCodexResumeArgs,
  buildMcpEnvConfigArgs,
  buildMcpPeerNameConfigArgs,
  buildWakeableEnv,
  isEmptyRolloutRaceError,
  parseWakeableLauncherArgs,
  waitForReadyz,
  waitForThreadIdle,
} from "../shared/wakeable-launcher.ts";

test("parseWakeableLauncherArgs parses launcher flags and passthrough args", () => {
  const opts = parseWakeableLauncherArgs([
    "--cwd", "/repo",
    "--port", "41037",
    "--name", "brisk-bison",
    "--alt-screen",
    "--materialize",
    "--",
    "--model", "gpt-5",
  ]);

  expect(opts.cwd).toBe("/repo");
  expect(opts.port).toBe(41037);
  expect(opts.peerName).toBe("brisk-bison");
  expect(opts.noAltScreen).toBe(false);
  expect(opts.materialize).toBe(true);
  expect(opts.extraCodexArgs).toEqual(["--model", "gpt-5"]);
});

test("parseWakeableLauncherArgs rejects out-of-range ports", () => {
  expect(() => parseWakeableLauncherArgs(["--port", "0"])).toThrow(/1 and 65535/i);
  expect(() => parseWakeableLauncherArgs(["--port", "65536"])).toThrow(/1 and 65535/i);
  expect(() => parseWakeableLauncherArgs(["--port", "12oops"])).toThrow(/1 and 65535/i);
});

test("parseWakeableLauncherArgs rejects invalid peer names", () => {
  expect(() => parseWakeableLauncherArgs(["--name", "not a peer"])).toThrow(/name/i);
});

test("parseWakeableLauncherArgs materializes by default so bare resume has a rollout", () => {
  const opts = parseWakeableLauncherArgs([]);

  expect(opts.materialize).toBe(true);
});

test("parseWakeableLauncherArgs honors --no-materialize opt-out", () => {
  const opts = parseWakeableLauncherArgs(["--no-materialize"]);

  expect(opts.materialize).toBe(false);
});

test("buildCodexResumeArgs targets the managed remote thread", () => {
  expect(buildCodexResumeArgs({
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: "/rollout.jsonl",
    peerName: "brisk-bison",
    noAltScreen: true,
    extraCodexArgs: ["--model", "gpt-5"],
  })).toEqual([
    "resume",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_URL=\"ws://127.0.0.1:41037\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_PID=\"123\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_THREAD_ID=\"thread-1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ROLLOUT_PATH=\"/rollout.jsonl\"",
    "-c",
    "mcp_servers.agent-peers.env.PEER_NAME=\"brisk-bison\"",
    "--remote",
    "ws://127.0.0.1:41037",
    "--no-alt-screen",
    "thread-1",
    "--model",
    "gpt-5",
  ]);
});

test("buildMcpEnvConfigArgs omits optional values when absent", () => {
  expect(buildMcpEnvConfigArgs({
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: null,
  })).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_URL=\"ws://127.0.0.1:41037\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_PID=\"123\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_THREAD_ID=\"thread-1\"",
  ]);
});

test("buildMcpPeerNameConfigArgs targets the app-server MCP child", () => {
  expect(buildMcpPeerNameConfigArgs("wakee2e")).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.PEER_NAME=\"wakee2e\"",
  ]);
  expect(buildMcpPeerNameConfigArgs()).toEqual([]);
});

test("buildWakeableEnv injects only wake registry hints, not broker secrets", () => {
  const env = buildWakeableEnv({
    baseEnv: { PATH: "/bin", AGENT_PEERS_ENABLED: "1" },
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: "/rollout.jsonl",
    peerName: "brisk-bison",
  });

  expect(env.AGENT_PEERS_WAKE_ENABLED).toBe("1");
  expect(env.AGENT_PEERS_WAKE_APP_SERVER_URL).toBe("ws://127.0.0.1:41037");
  expect(env.AGENT_PEERS_WAKE_APP_SERVER_PID).toBe("123");
  expect(env.AGENT_PEERS_WAKE_THREAD_ID).toBe("thread-1");
  expect(env.AGENT_PEERS_WAKE_ROLLOUT_PATH).toBe("/rollout.jsonl");
  expect(env.PEER_NAME).toBe("brisk-bison");
  expect(Object.keys(env).some((key) => key.toLowerCase().includes("session_token"))).toBe(false);
});

test("isEmptyRolloutRaceError matches only the transient app-server empty rollout race", () => {
  expect(isEmptyRolloutRaceError(new Error(
    "thread-store internal error: failed to read thread /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
  ))).toBe(true);
  expect(isEmptyRolloutRaceError(new Error("thread-store internal error: permission denied"))).toBe(false);
  expect(isEmptyRolloutRaceError("rollout at /tmp/rollout.jsonl is empty")).toBe(false);
});

test("waitForReadyz aborts a probe whose server never responds", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise(() => {});
      return new Response("never");
    },
  });
  try {
    const started = Date.now();
    await expect(waitForReadyz(server.port!, { timeoutMs: 180, probeTimeoutMs: 40 })).rejects.toThrow(/ready/);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    server.stop(true);
  }
});

test("waitForThreadIdle does not resume while the materialization turn is active", async () => {
  const statuses: ThreadStatus[] = [
    { type: "active", activeFlags: [] },
    { type: "idle" },
  ];
  let reads = 0;
  const thread = await waitForThreadIdle({
    async readThread(threadId: string) {
      return { id: threadId, cwd: "/repo", path: "/rollout", status: statuses[Math.min(reads++, 1)]! };
    },
  }, "thread-1", { timeoutMs: 500, pollIntervalMs: 1, sleep: async () => {} });
  expect(thread.status.type).toBe("idle");
  expect(reads).toBe(2);
});
