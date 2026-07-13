# Roast Hardening Audit

Date: 2026-07-13  
Source review: `.roast/REPORT-20260712T032056Z.md`  
Scope: broker, both MCP adapters, CLI-facing client behavior, persistence, documentation, CI and tests.

## Finding closure matrix

| Original finding | Resolution | Regression evidence | Status |
|---|---|---|---|
| Fake broker can steal the shared secret | Every authenticated POST first verifies a fresh nonce-bound HMAC proof from `/health`; response streams and timeouts are bounded. | `tests/broker-auth.test.ts`, `tests/broker-client.test.ts` impostor-capture and timeout cases | Closed |
| Peer messages are prompt injection | Peer-controlled text and metadata are serialized inside an explicit `UNTRUSTED_PEER_DATA` boundary; model instructions require treating them as data and obtaining user confirmation for consequential requests. | `tests/piggyback.test.ts` | Closed within the MCP prompt boundary |
| No resource limits | Central limits cover HTTP bodies, fields, messages, polling, acknowledgements, presentation, mailboxes, global retention, peer count and per-minute rates. Registration events survive unregister. | `tests/validation.test.ts`, quota/rate/cap cases in `tests/broker.test.ts` | Closed |
| Claude acknowledges before model-visible delivery | Claude persists leased messages before broker acknowledgement; `check_messages` reads the durable authoritative inbox and live channel delivery is best effort only. | `tests/e2e-live-delivery.test.ts`, `tests/codex-inbox-store.test.ts` | Closed; actual model attention cannot be proven by MCP |
| No retention/deletion policy | Acknowledged mail expires after 24 hours; orphaned mail and stale peer identities after seven days; explicit purge/diagnostic commands are documented. | GC and purge cases in `tests/broker.test.ts` | Closed |
| Broker requests can hang forever | Authenticated preflight and POST requests use deadlines; streamed responses have byte caps. | `tests/broker-client.test.ts` | Closed |
| Authentication failure looks successful | Poll/ack return an explicit session-expired error and HTTP 401; clients terminate their stale session rather than behaving as if the mailbox were empty. | broker and broker-client expired-session tests | Closed |
| Inbox trusts arbitrary JSON | Durable state has a schema, entry/count/byte limits, permission and ownership checks, and corrupt-file quarantine. | `tests/codex-inbox-store.test.ts` | Closed |
| Predictable temp files/cross-process writers | Writes use exclusive random temp files, fsync and atomic rename. Cross-process mutation uses an owner-checked file lock, merges under lock, compares lock inode on cleanup, and detects PID reuse by process start identity. | concurrent-writer and PID-reuse tests in `tests/codex-inbox-store.test.ts` | Closed |
| Registration/listing leak metadata | Machine listing omits PID, TTY, repository root and cwd; listing uses explicit safe projections. Active peer capacity equals the response cap so accepted live peers cannot disappear onto an unreachable page, while 1,024 restart identities may be retained. | discovery privacy/cap tests in `tests/broker.test.ts` | Closed |
| Auto-summary lacks consent | Model-generated summaries are disabled unless `AGENT_PEERS_AUTO_SUMMARY=1`; paths and filenames are redacted and repository metadata is framed as untrusted data. | `tests/summarize.test.ts` | Closed |
| Scope compares raw paths | CWD and repository paths are canonicalized before registration and scope queries. | `tests/peer-context.test.ts` | Closed |
| Polling uses N+1 sender lookups | Polling enriches messages with a bounded joined query. | poll tests in `tests/broker.test.ts` | Closed |
| Kill may terminate unrelated process | Lifecycle checks authenticate broker identity and avoid trusting a PID from a generic service; shutdown behavior is bounded and conservative. | broker-auth/client tests | Closed |
| Migration abandons in-flight mail | Migration preserves UUIDs and mailboxes, clears stale leases, rotates session tokens and provides a one-time legacy reclaim bootstrap. | `tests/migration.test.ts` | Closed |
| Error responses disclose internals | HTTP responses use normalized public errors and structured redacted logs. | broker error-path tests, `tests/logger.test.ts` | Closed |
| Terminal control sequences | User/peer-originated terminal fields are sanitized and bounded. | `tests/safe-output.test.ts` | Closed |
| Audit-history comments obscure invariants | Comments were rewritten around current delivery, authorization and persistence invariants; obsolete recent-delivery ring code was removed. | Typecheck and review | Closed |

## Independent-review follow-up

| Reviewer finding | Resolution | Evidence |
|---|---|---|
| CLI could POST to an impostor without preflight | Preflight moved into the shared POST primitive, covering every caller. | impostor never receives secret-header test |
| Restart could not recover promptly | Dead-PID or stale recovery is supported, with session rotation and lease clearing. | reclaim backlog unit/E2E tests |
| Dead PID allowed mailbox takeover by name alone | Broker requires a separate durable reclaim credential. Named adapters persist it in owner-only storage; an attacker gets a suffixed identity. | dead-peer takeover test, `tests/peer-identity.test.ts` |
| Same-name sessions could overwrite durable ownership | Identity creation is atomic create-if-absent; updates use credential compare-and-swap. A suffixed collision cannot replace the original owner's file. Rename persistence failure triggers a compensating broker rename rollback. | identity ownership and rename CAS tests in `tests/peer-identity.test.ts` |
| Late Codex ack could confirm an expired lease and duplicate delivery | Broker returns the exact accepted tokens; Codex removes only those tokens from pending state. Expired acknowledgements remain pending until a new lease token is obtained. | late-ack and replacement-token tests |
| Register/unregister bypassed rate limit | Short-window registration events are independent of peer rows and survive unregister. | register/unregister rate test |
| Live PID reuse could strand a file lock | Lock ownership includes the process start identity, not PID alone. | PID-reuse lock test |
| Delivery heuristics could acknowledge an unseen response | Only an explicit `ack_messages` call removes durable entries; acknowledgement batches are bounded. | explicit-ack and durable-inbox tests |
| Insecure inbox mode was silently repaired/read | Existing inbox files fail closed unless mode is exactly 0600. | insecure-mode test |

## Supply-chain and operations changes

- The Bun lockfile is tracked, dependency versions are exact, and CI actions are pinned to immutable commit SHAs.
- Diagnostics expose aggregate counts without message bodies, tokens or filesystem paths.
- README now labels the project experimental, describes actual Codex delivery constraints, documents opt-in summary behavior, retention, quotas and the same-user trust boundary.

## Residual risks (accepted and documented)

1. This remains a same-OS-user collaboration tool, not a hostile multi-tenant boundary. A process able to read the user's broker secret or database has operator-equivalent access.
2. Explicit `ack_messages` is evidence that the model chose to mark IDs processed, not proof of semantic attention or correct obedience.
3. Peer text is isolated and labelled but not sandboxed; downstream agents still have powerful tools and must follow the confirmation policy.
4. Messages are stored locally in SQLite/inbox files with strict permissions, not end-to-end encrypted.
5. Legacy databases permit a one-time same-name reclaim bootstrap because no prior durable reclaim credential could exist. New and already-bootstrapped identities require the credential.

## Verification gate

Before merge, run from the worktree:

```sh
/Users/siewbrayden/.bun/bin/bun install --frozen-lockfile
/Users/siewbrayden/.bun/bin/bun run typecheck
/Users/siewbrayden/.bun/bin/bun test
git diff --check
```
