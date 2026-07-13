import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PROOF_DOMAIN = "agent-peers-broker-health-v1";
const NONCE_RE = /^[a-f0-9]{64}$/;
const PROOF_RE = /^[a-f0-9]{64}$/;

export interface BrokerHealthProof {
  ok: true;
  pid: number;
  nonce: string;
  proof: string;
}

export function createHealthNonce(): string {
  return randomBytes(32).toString("hex");
}

export function createHealthProof(secret: string, nonce: string, pid: number): string {
  if (!NONCE_RE.test(nonce)) throw new Error("invalid health nonce");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid broker pid");
  return createHmac("sha256", secret)
    .update(`${PROOF_DOMAIN}\0${nonce}\0${pid}`)
    .digest("hex");
}

export function verifyHealthProof(
  value: unknown,
  secret: string,
  expectedNonce: string,
): value is BrokerHealthProof {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrokerHealthProof>;
  if (candidate.ok !== true || candidate.nonce !== expectedNonce) return false;
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return false;
  if (typeof candidate.proof !== "string" || !PROOF_RE.test(candidate.proof)) return false;
  try {
    const expected = createHealthProof(secret, expectedNonce, candidate.pid!);
    return timingSafeEqual(Buffer.from(candidate.proof, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
