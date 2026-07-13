import { expect, test } from "bun:test";
import {
  createHealthNonce,
  createHealthProof,
  verifyHealthProof,
} from "../shared/broker-auth.ts";

test("health proof authenticates the nonce and broker pid", () => {
  const secret = "s".repeat(64);
  const nonce = createHealthNonce();
  const value = { ok: true as const, pid: 42, nonce, proof: createHealthProof(secret, nonce, 42) };
  expect(verifyHealthProof(value, secret, nonce)).toBe(true);
});

test("health proof rejects another secret, nonce, pid, and malformed payload", () => {
  const secret = "s".repeat(64);
  const nonce = createHealthNonce();
  const proof = createHealthProof(secret, nonce, 42);
  expect(verifyHealthProof({ ok: true, pid: 42, nonce, proof }, "x".repeat(64), nonce)).toBe(false);
  expect(verifyHealthProof({ ok: true, pid: 42, nonce, proof }, secret, createHealthNonce())).toBe(false);
  expect(verifyHealthProof({ ok: true, pid: 43, nonce, proof }, secret, nonce)).toBe(false);
  expect(verifyHealthProof({ ok: true, pid: 42, nonce, proof: "bad" }, secret, nonce)).toBe(false);
});
