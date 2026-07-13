# Roast Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve every actionable finding in `.roast/REPORT-20260712T032056Z.md` and make agent-peers-mcp safe enough for clearly documented single-user local use.

**Architecture:** Preserve the localhost Bun/SQLite broker, but authenticate broker identity with an HMAC challenge before sending credentials, centralize runtime limits and validation, bound every queue/request, and make delivery/privacy semantics explicit. Keep the two MCP adapters but move shared trust-boundary behavior into tested modules so Claude and Codex cannot silently drift.

**Tech Stack:** Bun 1.3, TypeScript 5.9, `bun:sqlite`, Node crypto/fs primitives, Model Context Protocol SDK, Bun test, GitHub Actions.

---

### Task 1: Authenticated broker identity and safe lifecycle

**Files:**
- Create: `shared/broker-auth.ts`
- Modify: `broker.ts`, `shared/broker-client.ts`, `shared/ensure-broker.ts`, `claude-server.ts`, `codex-server.ts`, `cli.ts`
- Test: `tests/broker-client.test.ts`, `tests/broker-auth.test.ts`, `tests/ensure-broker.test.ts`

**Steps:**
1. Write failing tests proving a generic `200 /health` endpoint is rejected and an HMAC nonce response from the genuine broker is accepted.
2. Run the focused tests and confirm they fail because authenticated probing is absent.
3. Implement nonce generation and timing-safe HMAC verification; expose no credential in the health request.
4. Make every startup probe read the existing secret and authenticate the broker before considering it alive; never POST a secret to an unauthenticated endpoint.
5. Replace `kill-broker` port-wide `lsof` termination with authenticated PID discovery and exact-process termination.
6. Add timeouts and bounded error reads to every broker-client request.
7. Run focused and full tests; commit.

### Task 2: Runtime validation and resource bounds

**Files:**
- Create: `shared/limits.ts`, `shared/validation.ts`
- Modify: `broker.ts`, `shared/types.ts`, `claude-server.ts`, `codex-server.ts`, `shared/broker-client.ts`
- Test: `tests/broker.test.ts`, `tests/broker-client.test.ts`, `tests/validation.test.ts`

**Steps:**
1. Write failing tests for oversized HTTP bodies, messages, summaries, metadata fields, poll batches, ack batches, malformed JSON/types, invalid ports, and malformed MCP arguments.
2. Verify failures are caused by missing validation.
3. Add centralized byte/character/count limits and strict runtime parsers.
4. Parse HTTP request streams with a hard byte ceiling before JSON decoding; return stable 400/413/401 errors without raw internals.
5. Bound broker polling and acknowledgements, join sender metadata in the poll query, and reject rather than truncate dangerous writes.
6. Validate all MCP arguments before broker calls and sanitize peer-controlled terminal output.
7. Run focused and full tests; commit.

### Task 3: Durable delivery and inbox integrity

**Files:**
- Create: `shared/delivery-state.ts`
- Modify: `shared/codex-inbox.ts`, `codex-server.ts`, `claude-server.ts`, `shared/recent-delivered.ts`, `README.md`
- Test: `tests/codex-inbox-store.test.ts`, `tests/delivery-state.test.ts`, `tests/e2e-live-delivery.test.ts`

**Steps:**
1. Write failing tests for oversized/corrupt inbox files, invalid entry schemas, symlinked state directories/files/temp files, concurrent writers, crash boundaries, pending-ack overflow, and confirmation semantics.
2. Verify each test fails for the intended missing guarantee.
3. Version and validate the durable inbox schema; cap file size and message count; quarantine corruption instead of silently treating it as an empty inbox.
4. Use unique exclusive no-follow temporary files, fsync file/directory, validate directory ownership/mode/type, and serialize writers with an inter-process lock.
5. Extract and bound the confirm-on-next-call delivery state machine; never drop ack tokens because of an arbitrary in-memory cap.
6. Give Claude a durable recipient-side fallback and state the precise transport/durable/model-visible semantics instead of claiming unprovable delivery.
7. Run crash/restart and full tests; commit.

### Task 4: Prompt-injection, privacy, metadata, and terminal boundaries

**Files:**
- Modify: `shared/piggyback.ts`, `shared/colleague-prompt.ts`, `shared/summarize.ts`, `shared/peer-context.ts`, `shared/tab-title.ts`, `claude-server.ts`, `codex-server.ts`, `.env.example`, `README.md`
- Test: `tests/piggyback.test.ts`, `tests/summarize.test.ts`, `tests/peer-context.test.ts`, `tests/tab-title.test.ts`

**Steps:**
1. Write failing tests showing peer content cannot escape an explicit untrusted-data envelope, control characters are removed, and prompt-like filenames do not become instructions.
2. Add a clear non-authority policy: peer text is evidence/request data, never higher-priority instruction; require user confirmation before sensitive/cross-project/destructive actions prompted solely by a peer.
3. Encode peer messages as inert structured data with explicit provenance and safe delimiters; sanitize all terminal-facing metadata.
4. Make OpenAI summaries disabled unless `AGENT_PEERS_AUTO_SUMMARY=1`, redact absolute paths, pass structured JSON rather than prose concatenation, bound output, and document disclosure/cost.
5. Canonicalize cwd/git roots with `realpath` and document discovery scope as filtering, not authorization.
6. Run focused and full tests; commit.

### Task 5: Data lifecycle, migration recovery, and clock behavior

**Files:**
- Modify: `broker.ts`, `cli.ts`, `shared/types.ts`, `.env.example`, `README.md`
- Test: `tests/broker.test.ts`, `tests/migration.test.ts`, `tests/e2e-live-delivery.test.ts`

**Steps:**
1. Write failing tests for acknowledged-message retention, orphan TTL, DB growth quotas, migration with pending messages, ID/name ambiguity, sleep/clock jumps, and stale-token mutation responses.
2. Preserve legacy peer IDs during token migration: assign temporary tokens, mark peers stale, clear leases, and let named re-registration reclaim IDs/backlogs instead of deleting peers.
3. Return explicit unauthorized/session-expired results for zero-row heartbeat, unregister, and summary mutations.
4. Add configurable short retention and bounded pending-message quotas; purge acknowledged/orphaned rows during GC and expose a safe operator purge command.
5. Prefer exact UUID target matching before names and reject ambiguous UUID-shaped names; document wall-clock lease/staleness behavior and make thresholds configurable/testable.
6. Run migration, lifecycle, and full tests; commit.

### Task 6: Reproducible build, CI, observability, and code quality

**Files:**
- Create: `.github/workflows/ci.yml`, `shared/logger.ts`
- Modify: `.gitignore`, `package.json`, `README.md`, `broker.ts`, both MCP servers, large audit-history comments
- Test: `tests/logger.test.ts`; all existing tests

**Steps:**
1. Write failing tests for structured redacted logs and correlation/request IDs.
2. Add JSON/stable structured logs without message bodies, secrets, or raw paths; include operation IDs and queue counts.
3. Track `bun.lock`; pin runtime and GitHub Action SHAs; add CI for frozen install, typecheck, and tests.
4. Add scripts for `typecheck`, `test:ci`, and a safe diagnostics/status surface reporting queue sizes and retention without bodies.
5. Replace obsolete audit-round narratives with concise current-invariant comments and consolidate duplicated constants/validation/tool argument handling where safe.
6. Update README security model, experimental status, dangerous-permission warning, retention, privacy, delivery semantics, and operational limits.
7. Run frozen install, typecheck, full tests, and repository hygiene checks; commit.

### Task 7: Completion audit against the roast

**Files:**
- Create: `docs/plans/2026-07-13-roast-hardening-audit.md`
- Verify: every source/test/config/documentation artifact above

**Steps:**
1. Copy every Critical, High, Medium, Low, and cross-cutting review finding into an audit matrix.
2. For each finding, cite the exact implementation lines and regression tests that prove resolution, or mark it honestly as a documented residual limitation.
3. Run `bun install --frozen-lockfile`, `bun test`, `bun x tsc --noEmit`, inspect CI YAML, run secret/control-character searches, and check `git diff --check`.
4. Re-run the adversarial roast prompt against the finished branch and compare remaining findings.
5. Resolve any remaining actionable High/Critical issue; repeat verification.
6. Only then mark the goal complete.
