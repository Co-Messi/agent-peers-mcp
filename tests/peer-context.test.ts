import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalizePath } from "../shared/peer-context.ts";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

test("canonicalizePath resolves filesystem aliases", async () => {
  const base = await mkdtemp(join(tmpdir(), "agent-peers-path-"));
  dirs.push(base);
  const target = join(base, "target");
  const link = join(base, "alias");
  await Bun.$`mkdir -p ${target}`;
  await symlink(target, link, "dir");
  expect(await canonicalizePath(link)).toBe(await canonicalizePath(target));
});
