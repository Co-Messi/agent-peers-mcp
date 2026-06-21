// shared/wakeable-launcher.ts
// Managed launcher for app-server-backed wakeable Codex TUI sessions.

import { createServer } from "node:net";

import { CodexAppServerWsClient } from "./app-server-client.ts";
import { WakeLaunchClaimStore } from "./wake-launch-claims.ts";
import { getTty } from "./peer-context.ts";

export interface WakeableLauncherOptions {
  cwd: string;
  port?: number;
  peerName?: string;
  noAltScreen: boolean;
  materialize: boolean;
  extraCodexArgs: string[];
}

export function parseWakeableLauncherArgs(argv: string[]): WakeableLauncherOptions {
  const opts: WakeableLauncherOptions = {
    cwd: process.cwd(),
    noAltScreen: true,
    // Materialize by default: `thread/start` only reserves a rollout path; the
    // rollout JSONL is not written to disk until the thread takes its first
    // turn. `codex resume --remote <threadId>` requires that on-disk rollout to
    // exist, so without a setup turn the bare `codexpeer` launch fails with
    // "no rollout found for thread id ... (code -32600)". `--no-materialize`
    // remains as an experimental opt-out. See
    // .specs/2026-06-18-wakeable-codex-zed-recipe.md and error-patterns.md.
    materialize: true,
    extraCodexArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      opts.extraCodexArgs = argv.slice(i + 1);
      break;
    }
    if (arg === "--cwd" || arg === "-C") {
      opts.cwd = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--port") {
      opts.port = Number.parseInt(requireValue(argv, ++i, arg), 10);
      if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error("--port must be a positive integer");
      continue;
    }
    if (arg === "--name") {
      opts.peerName = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--alt-screen") {
      opts.noAltScreen = false;
      continue;
    }
    if (arg === "--materialize") {
      opts.materialize = true;
      continue;
    }
    if (arg === "--no-materialize") {
      opts.materialize = false;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return opts;
}

export function buildCodexResumeArgs(opts: {
  appServerUrl: string;
  appServerPid: number;
  threadId: string;
  rolloutPath: string | null;
  peerName?: string;
  noAltScreen: boolean;
  extraCodexArgs?: string[];
}): string[] {
  return [
    "resume",
    ...buildMcpEnvConfigArgs({
      appServerUrl: opts.appServerUrl,
      appServerPid: opts.appServerPid,
      threadId: opts.threadId,
      rolloutPath: opts.rolloutPath,
      peerName: opts.peerName,
    }),
    "--remote",
    opts.appServerUrl,
    ...(opts.noAltScreen ? ["--no-alt-screen"] : []),
    opts.threadId,
    ...(opts.extraCodexArgs ?? []),
  ];
}

export function buildMcpEnvConfigArgs(opts: {
  appServerUrl: string;
  appServerPid: number;
  threadId: string;
  rolloutPath: string | null;
  peerName?: string;
}): string[] {
  const values: Record<string, string> = {
    AGENT_PEERS_WAKE_ENABLED: "1",
    AGENT_PEERS_WAKE_APP_SERVER_URL: opts.appServerUrl,
    AGENT_PEERS_WAKE_APP_SERVER_PID: String(opts.appServerPid),
    AGENT_PEERS_WAKE_THREAD_ID: opts.threadId,
    ...(opts.rolloutPath ? { AGENT_PEERS_WAKE_ROLLOUT_PATH: opts.rolloutPath } : {}),
    ...(opts.peerName ? { PEER_NAME: opts.peerName } : {}),
  };

  return Object.entries(values).flatMap(([key, value]) => [
    "-c",
    `mcp_servers.agent-peers.env.${key}=${tomlString(value)}`,
  ]);
}

export function buildMcpPeerNameConfigArgs(peerName?: string): string[] {
  return peerName
    ? ["-c", `mcp_servers.agent-peers.env.PEER_NAME=${tomlString(peerName)}`]
    : [];
}

export function buildWakeableEnv(opts: {
  baseEnv: NodeJS.ProcessEnv;
  appServerUrl: string;
  appServerPid: number;
  threadId: string;
  rolloutPath: string | null;
  peerName?: string;
}): NodeJS.ProcessEnv {
  return {
    ...opts.baseEnv,
    ...(opts.peerName ? { PEER_NAME: opts.peerName } : {}),
    AGENT_PEERS_WAKE_ENABLED: "1",
    AGENT_PEERS_WAKE_APP_SERVER_URL: opts.appServerUrl,
    AGENT_PEERS_WAKE_APP_SERVER_PID: String(opts.appServerPid),
    AGENT_PEERS_WAKE_THREAD_ID: opts.threadId,
    ...(opts.rolloutPath ? { AGENT_PEERS_WAKE_ROLLOUT_PATH: opts.rolloutPath } : {}),
  };
}

export async function runWakeableLauncher(opts: WakeableLauncherOptions): Promise<number> {
  const port = opts.port ?? await allocatePort();
  const appServerUrl = `ws://127.0.0.1:${port}`;
  const claimStore = new WakeLaunchClaimStore();
  const claim = await claimStore.create({
    cwd: opts.cwd,
    tty: getTty(),
    requestedPeerName: opts.peerName,
  });
  let claimReady = false;

  const appServer = Bun.spawn([
    "codex",
    ...buildMcpPeerNameConfigArgs(opts.peerName),
    "app-server",
    "--listen",
    appServerUrl,
  ], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await claimStore.update(claim.claim_id, {
    app_server_url: appServerUrl,
    app_server_pid: appServer.pid,
  });

  try {
    await waitForReadyz(port);
    const client = new CodexAppServerWsClient(appServerUrl);
    let thread = await client.startThread({ cwd: opts.cwd });
    if (opts.materialize) {
      await retryEmptyRolloutRace(() => client.startWakeTurn({
        threadId: thread.id,
        clientUserMessageId: "agent-peers-wakeable-materialize",
        prompt: "Wakeable Codex session initialized for agent-peers. Reply exactly: WAKEABLE_CODEX_READY. Do not use tools.",
        wakeId: "wakeable-materialize",
        pendingSignature: "materialize",
      }));
      thread = await retryEmptyRolloutRace(() => client.readThread(thread.id));
    }
    await claimStore.update(claim.claim_id, {
      thread_id: thread.id,
      rollout_path: thread.path,
      status: "ready",
    });
    claimReady = true;
    client.close();

    const codexArgs = buildCodexResumeArgs({
      appServerUrl,
      appServerPid: appServer.pid,
      threadId: thread.id,
      rolloutPath: thread.path,
      peerName: opts.peerName,
      noAltScreen: opts.noAltScreen,
      extraCodexArgs: opts.extraCodexArgs,
    });
    const env = buildWakeableEnv({
      baseEnv: process.env,
      appServerUrl,
      appServerPid: appServer.pid,
      threadId: thread.id,
      rolloutPath: thread.path,
      peerName: opts.peerName,
    });

    console.error(`[agent-peers/wakeable] app-server=${appServerUrl} pid=${appServer.pid}`);
    console.error(`[agent-peers/wakeable] thread=${thread.id}`);
    const tui = Bun.spawn(["codex", ...codexArgs], {
      cwd: opts.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
    await claimStore.update(claim.claim_id, { tui_pid: tui.pid });
    return await tui.exited;
  } finally {
    if (!claimReady) {
      await claimStore.update(claim.claim_id, { status: "failed" }).catch(() => {});
    }
    try { appServer.kill("SIGTERM"); } catch { /* best effort */ }
    await appServer.exited.catch(() => {});
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address && typeof address.port === "number") {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}

async function waitForReadyz(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  const url = `http://127.0.0.1:${port}/readyz`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* keep polling */
    }
    await Bun.sleep(100);
  }
  throw new Error(`app-server did not become ready at ${url}`);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function isEmptyRolloutRaceError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("thread-store internal error")
    && error.message.includes("rollout at ")
    && error.message.includes(" is empty");
}

async function retryEmptyRolloutRace<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isEmptyRolloutRaceError(error)) throw error;
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("empty rollout retry failed");
}
