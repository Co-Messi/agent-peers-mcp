// tests/shared-secret.test.ts
// Focused tests for the secret-file trust boundary (Codex round-I).
// validateSecretFilePerms is fail-closed: wrong owner, wrong mode, symlink,
// or non-regular-file must throw. readSharedSecret wraps validation and
// returns null (surfaced via stderr) on any validation failure.

import { describe, test, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSecretFilePerms,
  readSharedSecret,
} from "../shared/shared-secret.ts";

const scratchDirs: string[] = [];
function mkScratch(): string {
  const d = mkdtempSync(join(tmpdir(), "agent-peers-secret-test-"));
  scratchDirs.push(d);
  return d;
}

afterEach(() => {
  while (scratchDirs.length) {
    const d = scratchDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("validateSecretFilePerms", () => {
  test("accepts a 0600 file owned by current user", () => {
    const dir = mkScratch();
    const p = join(dir, "secret");
    writeFileSync(p, "x".repeat(64), { mode: 0o600 });
    chmodSync(p, 0o600);
    expect(() => validateSecretFilePerms(p)).not.toThrow();
  });

  test("rejects a world-readable 0644 file (other users can read it)", () => {
    const dir = mkScratch();
    const p = join(dir, "secret");
    writeFileSync(p, "x".repeat(64), { mode: 0o644 });
    chmodSync(p, 0o644);
    expect(() => validateSecretFilePerms(p)).toThrow(/mode 644/);
  });

  test("rejects a group-readable 0640 file", () => {
    const dir = mkScratch();
    const p = join(dir, "secret");
    writeFileSync(p, "x".repeat(64), { mode: 0o640 });
    chmodSync(p, 0o640);
    expect(() => validateSecretFilePerms(p)).toThrow(/mode 640/);
  });

  test("rejects a symlink even if the target is 0600", () => {
    const dir = mkScratch();
    const real = join(dir, "real");
    const link = join(dir, "link");
    writeFileSync(real, "x".repeat(64), { mode: 0o600 });
    chmodSync(real, 0o600);
    symlinkSync(real, link);
    expect(() => validateSecretFilePerms(link)).toThrow(/symlink/);
  });
});

describe("readSharedSecret", () => {
  test("returns null for a nonexistent path", () => {
    const dir = mkScratch();
    const p = join(dir, "does-not-exist");
    expect(existsSync(p)).toBe(false);
    expect(readSharedSecret(p)).toBeNull();
  });

  test("returns null and logs for a world-readable file (fail-closed)", () => {
    const dir = mkScratch();
    const p = join(dir, "secret");
    writeFileSync(p, "x".repeat(64), { mode: 0o644 });
    chmodSync(p, 0o644);
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
    try {
      expect(readSharedSecret(p)).toBeNull();
      expect(errs.some((e) => /shared secret validation failed/.test(e))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("returns null for a too-short (partial-write) file even if perms are correct", () => {
    const dir = mkScratch();
    const p = join(dir, "secret");
    writeFileSync(p, "short", { mode: 0o600 });
    chmodSync(p, 0o600);
    expect(readSharedSecret(p)).toBeNull();
  });

  test("returns the secret string for a well-formed file", () => {
    const dir = mkScratch();
    const p = join(dir, "secret");
    const expected = "a".repeat(64);
    writeFileSync(p, expected, { mode: 0o600 });
    chmodSync(p, 0o600);
    expect(readSharedSecret(p)).toBe(expected);
  });
});
