# Codex Conversation Flow Design

**Date:** 2026-04-15
**Status:** Approved for implementation

## Goal

Make `Claude <-> Codex` and `Codex <-> Codex` feel as close as possible to the current `Claude <-> Claude` experience without relying on unsupported Codex client push primitives or fragile terminal injection.

The design target is not "reply instantly." The design target is "notice messages quickly, keep sender identity and context intact, stay quiet while investigating, and reply only when there is a substantive update or a clarifying question."

## Reference Behavior

Today, Claude feels live because [claude-server.ts](/Users/siewbrayden/Github%20Repos/agent-peers-mcp/.worktrees/codex-conversation/claude-server.ts) has a background polling loop that:

- polls the broker every second;
- pushes inbound messages through `notifications/claude/channel`;
- acks after transport success;
- keeps sender metadata with each message.

Today, Codex is passive because [codex-server.ts](/Users/siewbrayden/Github%20Repos/agent-peers-mcp/.worktrees/codex-conversation/codex-server.ts) only polls when an `agent-peers` tool is called. That means inbound peer messages wait at the broker until Codex touches the MCP again.

## Recommended Approach

Use a **Claude-like background polling loop inside the Codex server**, but do not pretend Codex has Claude's native push UI.

Instead:

1. Codex polls the broker in the background every second, just like Claude.
2. Newly leased messages are moved into a local, durable Codex inbox queue.
3. Tool calls drain that local queue into a structured `[PEER INBOX]` block.
4. Messages stay associated with sender metadata and conversation context.
5. Replies should only be sent when the peer has a substantive update or a clarifying question.

This keeps the reliability and delivery semantics in the current broker while making Codex much more active and much less likely to miss or delay messages.

## Why This Approach

This is the strongest safe fix because it:

- keeps the runtime architecture close to the proven Claude flow;
- avoids terminal injection into a live Codex session;
- avoids inventing unsupported Codex push APIs;
- preserves lease/ack/orphan guarantees already covered by broker tests;
- improves user-visible responsiveness even when Codex is busy with unrelated work.

It is intentionally not a hidden second Codex agent and not an immediate auto-responder. The active peer remains the real Codex session the user launched.

## Architecture Changes

### 1. Background Codex Poll Loop

`codex-server.ts` gets a self-scheduling poll loop mirroring Claude's non-overlapping `pollAndPush` structure.

Differences from Claude:

- Claude pushes directly into the client with `notifications/claude/channel`.
- Codex stores the leased messages in a local inbox queue because Codex has no equivalent push surface exposed here.

### 2. Durable Local Inbox Queue

Add a small local store under the user's home directory for Codex peer state.

Recommended path:

- `~/.agent-peers-codex/<peer-id>.json`

State stored per peer:

- unread leased messages already fetched from the broker;
- lease tokens waiting for safe ack;
- dedupe information for the current session;
- optional lightweight conversation metadata keyed by sender name.

Durability matters because background polling should not lose context if the MCP process restarts between poll and next tool response.

### 3. Tool-Call Delivery From Local Queue

`withPiggyback()` in `codex-server.ts` changes from:

- flush old acks;
- poll broker now;
- inject fresh messages;

to:

- flush previously safe-to-ack leases;
- read unread messages from the local queue;
- inject them as one coherent inbox block;
- mark those queue items as "presented" so the next successful tool call can ack them.

The queue becomes the handoff boundary between background delivery and visible Codex behavior.

### 4. Conversation-Aware Inbox Formatting

Keep the current sender identity fields and strengthen the wording so Codex clearly sees:

- who sent the message;
- whether the sender is `claude` or `codex`;
- what the sender said;
- that it should stay silent until it has a real update or a real question.

This should be reflected in both:

- the server `instructions`;
- the rendered `[PEER INBOX]` text.

### 5. Substantive Reply Policy

Update peer guidance on both Claude and Codex sides.

Current Claude prompt says "respond immediately." That does not match the desired coworker behavior.

New rule:

- acknowledge internally, not externally;
- continue investigation;
- only send a peer message when:
  - there is a substantive update,
  - there is a blocker,
  - there is a risk or decision the other peer should know,
  - or clarification is needed to proceed.

This keeps the conversation human-like instead of noisy.

## Delivery Semantics

The broker remains the source of truth. We do not change the broker lease/ack protocol.

Codex semantics after this change:

- broker poll happens in the background;
- delivery to the model still occurs on a safe visible boundary;
- ack still happens only after the prior visible delivery is known to have completed;
- expired leases still re-deliver;
- orphan handling remains unchanged.

This means we preserve the existing correctness model while reducing perceived passivity.

## Failure Handling

### Broker Poll Failure

- leave the local queue unchanged;
- retry on next poll cycle;
- log to stderr.

### Queue Write Failure

- do not ack broker leases;
- let leases expire naturally and re-deliver;
- log loudly.

### Crash After Queue Write, Before Visible Delivery

- messages are still in local queue;
- no ack has happened yet;
- next startup can restore queue state and continue.

### Crash After Visible Delivery, Before Ack Flush

- queue state marks those messages as presented;
- next tool call retries ack;
- if lease already expired, broker may re-deliver and session dedupe prevents same-session duplication.

## Testing Strategy

Add coverage for:

- Codex background poller writes unread messages into local queue;
- queue-backed delivery prepends inbox without repolling broker inline;
- ack-on-next-call still works with queue-backed leases;
- queue survives restart boundary;
- queue write failure does not silently ack;
- new inbox formatting preserves sender identity and reply policy.

Also update prompt-facing tests and README language to reflect "substantive updates only."

## Non-Goals

- true Codex client push notifications identical to Claude channel push;
- hidden terminal text injection into live Codex;
- immediate auto-replies with no substantive information;
- replacing the current broker protocol.

## Success Criteria

We are done when:

- Codex notices peer messages quickly even when it has not recently called an `agent-peers` tool;
- peer messages arriving from Claude are clearly identified as Claude-originated;
- Codex can carry on a real asynchronous conversation through meaningful updates;
- message reliability remains consistent with the current broker guarantees;
- the experience feels much closer to `Claude <-> Claude` than today's piggyback-only Codex flow.
