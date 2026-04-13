# agent-peers-mcp

Peer discovery + messaging MCP for Claude Code **and** Codex CLI sessions running on the same machine. Any agent can discover any other (Claude↔Claude, Claude↔Codex, Codex↔Codex) and send messages that arrive instantly for Claude (channel push) or on the next tool call for Codex (piggyback).

Runs **fully isolated** from upstream `claude-peers-mcp`: different port (7900 vs 7899), different DB (`~/.agent-peers.db`), different MCP registration name (`agent-peers`). Both can be installed side by side.

## Install

```bash
cd "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp"
bun install
```

### Register for Claude Code (global)

```bash
claude mcp add --scope user --transport stdio agent-peers -- \
  bun "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/claude-server.ts"
```

Add this alias to `~/.zshrc`:

```bash
alias agentpeers='claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'
```

Then `source ~/.zshrc`.

### Register for Codex CLI

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-peers]
command = "bun"
args = ["/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/codex-server.ts"]
```

## Usage

```bash
agentpeers                          # launch Claude with the peer network
PEER_NAME=frontend-tab agentpeers   # launch with an explicit name
codex                               # Codex picks up the MCP via config.toml
```

Inside any session:

> "List all peers on this machine"
> "Send a message to peer frontend-tab: what are you working on?"
> "Rename me to backend-codex"

## CLI

```bash
bun cli.ts status                       # broker + peer list
bun cli.ts peers                        # peer list only
bun cli.ts send <name-or-id> "<msg>"    # inject a message from the shell
bun cli.ts rename <name-or-id> <new>    # admin rename a peer
bun cli.ts orphaned-messages            # list messages whose recipient died before delivery
bun cli.ts kill-broker                  # stop the broker daemon
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PEERS_PORT` | `7900` | Broker port |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | SQLite path |
| `PEER_NAME` | (auto-generated adjective-noun) | Human-readable peer name at launch |
| `OPENAI_API_KEY` | — | Enables gpt-5.4-nano auto-summary |
| `AGENT_PEERS_DISABLE_TAB_TITLE` | — | Set to `1` to skip terminal tab title |

## Coexistence with upstream `claude-peers-mcp`

| | upstream `claude-peers-mcp` | this `agent-peers-mcp` |
|---|---|---|
| broker port | 7899 | 7900 |
| SQLite | `~/.claude-peers.db` | `~/.agent-peers.db` |
| MCP name | `claude-peers` | `agent-peers` |
| alias | `claudedpeers` | `agentpeers` |

Both run simultaneously. They do not talk to each other.

## Delivery contract

**Within a session**: deterministic dedupe by `message_id` via in-memory seen-set. Claude receives via channel push, Codex receives via piggyback on the next tool call (including `list_peers`, `set_summary`, or `check_messages`).

**Across a process restart** that reclaims the same UUID (PEER_NAME matches a stale peer within 60s): **at-least-once**. The same message may be re-delivered once because the seen-set is in-memory and resets. Replies should be idempotent.

**When a peer dies before delivery**: messages become orphans, visible via `bun cli.ts orphaned-messages`. Not silently lost.

See `docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md` for the full contract and the review-driven design rationale.
