import { afterEach, expect, test } from "bun:test";

import { CodexAppServerWsClient } from "../shared/app-server-client.ts";

test("client rejects non-positive request timeouts", () => {
  expect(() => new CodexAppServerWsClient("ws://127.0.0.1:1", { timeoutMs: 0 })).toThrow(/timeout/i);
});

test("client rejects non-loopback or credential-bearing app-server URLs", () => {
  expect(() => new CodexAppServerWsClient("ws://example.com:1234")).toThrow(/loopback/i);
  expect(() => new CodexAppServerWsClient("ws://user:pass@127.0.0.1:1234")).toThrow(/loopback/i);
  expect(() => new CodexAppServerWsClient("http://127.0.0.1:1234")).toThrow(/loopback/i);
});

const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) {
    try { stop(); } catch { /* best effort */ }
  }
});

test("request rejects when the app-server upgrades but never responds (request timeout)", async () => {
  // A websocket server that accepts the connection but never sends a reply.
  // initialize() (issued inside connect()) should therefore time out, and any
  // caller awaiting connect() should reject rather than hang forever.
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: { open() {}, message() {} },
  });
  stoppers.push(() => server.stop(true));

  const client = new CodexAppServerWsClient(`ws://127.0.0.1:${server.port}`, { timeoutMs: 150 });
  const start = Date.now();
  await expect(client.listLoadedThreads()).rejects.toThrow(/timed out/);
  expect(Date.now() - start).toBeLessThan(2_000);
  client.close();
});

test("connect rejects fast when nothing is listening", async () => {
  // Port 1 is privileged/unused; the connection is refused quickly.
  const client = new CodexAppServerWsClient("ws://127.0.0.1:1", { timeoutMs: 300 });
  const start = Date.now();
  await expect(client.listLoadedThreads()).rejects.toThrow();
  expect(Date.now() - start).toBeLessThan(2_000);
  client.close();
});

test("connect completes the initialize handshake before thread requests", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open() {},
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as { id?: number; method: string };
        seen.push(message.method);
        if (message.method === "initialize") ws.send(JSON.stringify({ id: message.id, result: {} }));
        if (message.method === "thread/loaded/list") ws.send(JSON.stringify({ id: message.id, result: { data: [] } }));
      },
    },
  });
  stoppers.push(() => server.stop(true));

  const client = new CodexAppServerWsClient(`ws://127.0.0.1:${server.port}`);
  await client.listLoadedThreads();
  expect(seen).toEqual(["initialize", "initialized", "thread/loaded/list"]);
  client.close();
});
