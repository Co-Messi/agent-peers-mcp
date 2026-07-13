import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadPeerIdentity, savePeerIdentity } from "../shared/peer-identity.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/agent-peers-identity-");
  roots.push(root);
  return root;
}

test("named peer identity round-trips in owner-only storage", async () => {
  const root = await tempRoot();
  const identity = { name: "stable-codex", reclaim_token: "a".repeat(36) };
  expect(await loadPeerIdentity("codex", "stable-codex", root)).toBeNull();
  expect(await savePeerIdentity("codex", "stable-codex", identity, root)).toBe(true);
  expect(await loadPeerIdentity("codex", "stable-codex", root)).toEqual(identity);
  expect((await lstat(root)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(root, "codex-stable-codex.json"))).mode & 0o777).toBe(0o600);
});

test("same-name session cannot overwrite the durable identity owner", async () => {
  const root = await tempRoot();
  const owner = { name: "shared", reclaim_token: "d".repeat(36) };
  const suffix = { name: "shared-2", reclaim_token: "e".repeat(36) };
  expect(await savePeerIdentity("codex", "shared", owner, root)).toBe(true);
  expect(await savePeerIdentity("codex", "shared", suffix, root, owner.reclaim_token)).toBe(false);
  expect(await loadPeerIdentity("codex", "shared", root)).toEqual(owner);
});

test("durable identity rename uses credential compare-and-swap", async () => {
  const root = await tempRoot();
  const token = "f".repeat(36);
  await savePeerIdentity("claude", "original", { name: "original", reclaim_token: token }, root);
  expect(await savePeerIdentity(
    "claude", "original", { name: "renamed", reclaim_token: token }, root, token, "original",
  )).toBe(true);
  expect(await loadPeerIdentity("claude", "original", root)).toEqual({ name: "renamed", reclaim_token: token });
});

test("concurrent durable renames cannot overwrite a newer name with a stale update", async () => {
  const root = await tempRoot();
  const token = "9".repeat(36);
  await savePeerIdentity("codex", "stable", { name: "stable", reclaim_token: token }, root);
  const results = await Promise.all([
    savePeerIdentity("codex", "stable", { name: "first", reclaim_token: token }, root, token, "stable"),
    savePeerIdentity("codex", "stable", { name: "second", reclaim_token: token }, root, token, "stable"),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(["first", "second"]).toContain((await loadPeerIdentity("codex", "stable", root))?.name ?? "");
});

test("anonymous peers do not persist a shared reclaim credential", async () => {
  const root = await tempRoot();
  await savePeerIdentity("claude", undefined, { name: "random", reclaim_token: "b".repeat(36) }, root);
  expect(await loadPeerIdentity("claude", undefined, root)).toBeNull();
  expect((await lstat(root)).isDirectory()).toBe(true);
});

test("identity loader fails closed on weak permissions and symlinks", async () => {
  const root = await tempRoot();
  const path = join(root, "codex-unsafe.json");
  await writeFile(path, JSON.stringify({ name: "unsafe", reclaim_token: "c".repeat(36) }), { mode: 0o644 });
  await chmod(path, 0o644);
  await expect(loadPeerIdentity("codex", "unsafe", root)).rejects.toThrow(/mode/i);
  await rm(path);
  const target = join(root, "target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, path);
  await expect(loadPeerIdentity("codex", "unsafe", root)).rejects.toThrow(/unsafe/i);
});
