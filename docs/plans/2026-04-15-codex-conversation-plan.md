# Codex Conversation Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Codex peer messaging behave much closer to Claude peer messaging by adding background polling, a durable local Codex inbox, and a substantive-update reply policy.

**Architecture:** Codex keeps the existing broker lease/ack protocol but moves message polling into a Claude-style background loop. Inbound Codex messages are stored in a local durable queue, then surfaced to the model on safe tool-call boundaries. Claude and Codex prompts are both updated to prefer substantive follow-up over immediate chatter.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` or JSON-backed local state, existing MCP SDK, existing broker-client and broker lease/ack semantics.

---

### Task 1: Add failing tests for Codex local inbox state

**Files:**
- Create: `tests/codex-inbox-store.test.ts`
- Modify: `shared/` implementation files to satisfy new tests

**Step 1: Write the failing test**

Cover:
- enqueue unread leased messages;
- mark messages presented;
- move presented lease tokens into pending-ack state;
- clear acked messages;
- persist and reload state across restart.

**Step 2: Run test to verify it fails**

Run: `bun test tests/codex-inbox-store.test.ts`
Expected: FAIL because the inbox store does not exist yet.

**Step 3: Write minimal implementation**

Add a Codex inbox store module with:
- `loadInboxState`
- `queueLeasedMessages`
- `getUnreadMessages`
- `markPresented`
- `ackPresented`
- `resetInboxState`

**Step 4: Run test to verify it passes**

Run: `bun test tests/codex-inbox-store.test.ts`
Expected: PASS

**Step 5: Commit**

Run:
```bash
git add tests/codex-inbox-store.test.ts shared
git commit -m "test: add codex inbox store coverage"
```

### Task 2: Refactor Codex server to use background polling + local queue

**Files:**
- Modify: `codex-server.ts`
- Modify: `shared/broker-client.ts` only if typed helpers need extension
- Test: `tests/codex-inbox-store.test.ts`

**Step 1: Write the failing integration-oriented test or assertions**

If direct server integration tests are too heavy, add focused unit coverage around:
- poll cycle writing queue state;
- tool-call delivery reading queued messages instead of broker-polling inline;
- ack-on-next-call preserving current semantics.

**Step 2: Run targeted tests to verify failure**

Run: `bun test tests/codex-inbox-store.test.ts tests/piggyback.test.ts`
Expected: FAIL until server behavior is updated to use the new queue semantics.

**Step 3: Write minimal implementation**

In `codex-server.ts`:
- add a Claude-style self-scheduling poll loop;
- store newly leased messages in the Codex inbox store;
- keep same-session dedupe;
- update `withPiggyback()` to drain queued unread messages;
- keep ack-on-next-call, but source tokens from presented queue state instead of only in-memory arrays.

**Step 4: Run tests to verify behavior**

Run: `bun test`
Expected: PASS

**Step 5: Commit**

Run:
```bash
git add codex-server.ts shared tests
git commit -m "feat: make codex peer delivery queue-backed"
```

### Task 3: Tighten peer messaging guidance and inbox formatting

**Files:**
- Modify: `claude-server.ts`
- Modify: `codex-server.ts`
- Modify: `shared/piggyback.ts`
- Modify: `tests/piggyback.test.ts`

**Step 1: Write the failing test**

Update `tests/piggyback.test.ts` so the expected inbox copy:
- preserves sender identity clearly;
- says replies should be substantive updates or clarification requests;
- avoids "respond immediately" language.

**Step 2: Run test to verify it fails**

Run: `bun test tests/piggyback.test.ts`
Expected: FAIL with old wording.

**Step 3: Write minimal implementation**

Update:
- Claude instructions to stop telling the model to respond immediately;
- Codex instructions to match the same coworker-style rule;
- piggyback formatting to reinforce sender identity and substantive replies.

**Step 4: Run test to verify it passes**

Run: `bun test tests/piggyback.test.ts`
Expected: PASS

**Step 5: Commit**

Run:
```bash
git add claude-server.ts codex-server.ts shared/piggyback.ts tests/piggyback.test.ts
git commit -m "feat: make peer replies substantive by default"
```

### Task 4: Add documentation for the new Codex behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md`

**Step 1: Write the failing doc expectation**

Document that:
- Codex now polls in the background;
- visible delivery still happens on safe tool boundaries;
- replies should be substantive, not immediate acknowledgments.

**Step 2: Update documentation**

Reflect the new behavior in usage, known behaviors, and architecture sections.

**Step 3: Verify docs**

Run:
```bash
rg -n "respond immediately|next tool call|zero polling overhead when idle" README.md docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md claude-server.ts codex-server.ts
```
Expected:
- no stale "respond immediately" wording;
- no stale statement that Codex has zero polling overhead when idle.

**Step 4: Commit**

Run:
```bash
git add README.md docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md
git commit -m "docs: describe active codex peer delivery"
```

### Task 5: Self-critique and verification

**Files:**
- Review all modified files

**Step 1: Run full verification**

Run:
```bash
bun test
```
Expected: PASS

**Step 2: Run targeted static review**

Check:
- queue files are not accidentally committed outside repo paths;
- ack ordering still prevents silent loss;
- restart path does not drop unread queue entries;
- instructions match desired human-like behavior.

**Step 3: Inspect git diff**

Run:
```bash
git status --short
git diff --stat
git diff -- README.md claude-server.ts codex-server.ts shared tests docs
```

**Step 4: Commit any final fixes**

Run:
```bash
git add .
git commit -m "fix: polish codex conversation flow"
```

### Task 6: Publish branch and open PR

**Files:**
- None

**Step 1: Push branch**

Run:
```bash
git push -u origin feat/codex-conversation-flow
```

**Step 2: Open PR**

Title:
```text
feat: make codex peer messaging feel closer to claude
```

Body should summarize:
- background Codex polling;
- durable queue-backed inbox;
- substantive-update reply policy;
- tests and docs updated.
