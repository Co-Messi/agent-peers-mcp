# agent-peers-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified peer-discovery + messaging MCP supporting both Claude Code and Codex CLI sessions through a single broker, with lease+ack delivery, timer-driven GC, human-readable names, terminal tab titles, and self-rename — all isolated from the existing stable `claude-peers-mcp` on port 7899.

**Architecture:** One broker daemon on `localhost:7900` + SQLite at `~/.agent-peers.db`. Two MCP server binaries (`claude-server.ts` with `claude/channel` push, `codex-server.ts` with tool-call piggyback delivery) sharing a `shared/` core. Immutable UUID + mutable unique name per peer. Every delivery path uses lease (poll) → ack (after transport confirmed) for reliability.

**Tech Stack:** Bun runtime, TypeScript 5.9+, `@modelcontextprotocol/sdk`, `bun:sqlite` (WAL mode), `Bun.serve()` HTTP, `Bun.spawn()` for broker daemon, OpenAI SDK (gpt-5.4-nano, optional auto-summary).

**Spec reference:** `docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md`

**Execution notes:**
- All paths assume working directory `/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/`
- Run every `bun test` command from that directory
- Commits are scoped per task — do not combine across tasks
- Never skip hooks or sign-offs

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize git and Bun project**

Run from the project root:
```bash
cd "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp"
git init
bun init -y
```

- [ ] **Step 2: Replace `package.json` with the project-specific version**

Overwrite `package.json`:
```json
{
  "name": "agent-peers-mcp",
  "version": "0.1.0",
  "type": "module",
  "description": "Unified peer-discovery and messaging MCP for Claude Code + Codex CLI sessions",
  "private": true,
  "scripts": {
    "broker": "bun broker.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1"
  },
  "devDependencies": {
    "@types/bun": "^1.3.11",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun-types"],
    "lib": ["ES2022"],
    "skipLibCheck": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
bun.lock
*.db
*.db-journal
*.db-wal
*.db-shm
.DS_Store
.env
.env.local
dist/
```

- [ ] **Step 5: Write `.env.example`**

```
# Optional — enables auto-summary of what each session is working on
OPENAI_API_KEY=

# Optional — broker port (default 7900)
AGENT_PEERS_PORT=7900

# Optional — SQLite DB path (default ~/.agent-peers.db)
AGENT_PEERS_DB=

# Optional — peer name at launch (default: auto-generated adjective-noun)
PEER_NAME=

# Optional — set to 1 to skip writing terminal tab title
AGENT_PEERS_DISABLE_TAB_TITLE=
```

- [ ] **Step 6: Install dependencies**

```bash
bun install
```

- [ ] **Step 7: Verify TypeScript type-checks the empty project**

```bash
bunx tsc --noEmit
```
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example bun.lock
git commit -m "chore: scaffold agent-peers-mcp project"
```

---

## Task 2: Shared types

**Files:**
- Create: `shared/types.ts`

- [ ] **Step 1: Write `shared/types.ts`**

```ts
// shared/types.ts
// Canonical types used by broker, clients, and CLI.

export type PeerId = string; // UUID v4
export type PeerType = "claude" | "codex";
export type PeerName = string; // 1-32 chars, ^[a-zA-Z0-9_-]+$

export interface Peer {
  id: PeerId;
  name: PeerName;
  peer_type: PeerType;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface LeasedMessage {
  id: number; // monotonic autoincrement row id
  from_id: PeerId;
  from_name: PeerName;
  from_peer_type: PeerType;
  from_cwd: string;
  from_summary: string;
  to_id: PeerId;
  text: string;
  sent_at: string;
  lease_token: string; // UUID v4, opaque to client
}

// ----- Broker API request/response -----

export interface RegisterRequest {
  peer_type: PeerType;
  name?: PeerName; // from PEER_NAME env; broker auto-generates if missing
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  name: PeerName; // resolved (may differ from requested if collision → suffix added)
}

export interface HeartbeatRequest { id: PeerId; }

export interface UnregisterRequest { id: PeerId; }

export interface SetSummaryRequest { id: PeerId; summary: string; }

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  peer_type?: PeerType; // optional filter
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id_or_name: string; // accepts UUID or name
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message_id?: number;
}

export interface PollMessagesRequest { id: PeerId; }

export interface PollMessagesResponse {
  messages: LeasedMessage[];
}

export interface AckMessagesRequest {
  id: PeerId;
  lease_tokens: string[];
}

export interface AckMessagesResponse {
  ok: boolean;
  acked: number;
}

export interface RenamePeerRequest {
  id: PeerId;
  new_name: PeerName;
}

export interface RenamePeerResponse {
  ok: boolean;
  error?: string;
  name?: PeerName;
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: shared types for broker API"
```

---

## Task 3: Name wordlist + generator

**Files:**
- Create: `shared/names.ts`
- Create: `tests/names.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/names.test.ts`:
```ts
import { test, expect } from "bun:test";
import { generateName, isValidName, NAME_REGEX } from "../shared/names";

test("generateName returns adjective-noun", () => {
  const name = generateName();
  expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  expect(name.length).toBeGreaterThanOrEqual(5);
  expect(name.length).toBeLessThanOrEqual(32);
});

test("generateName varies across calls", () => {
  const s = new Set<string>();
  for (let i = 0; i < 20; i++) s.add(generateName());
  // With 50x50 pool, 20 draws almost always produce > 1 unique value.
  expect(s.size).toBeGreaterThan(1);
});

test("isValidName rejects empty, too long, bad chars, and UUID-shaped", () => {
  expect(isValidName("")).toBe(false);
  expect(isValidName("a".repeat(33))).toBe(false);
  expect(isValidName("has space")).toBe(false);
  expect(isValidName("has/slash")).toBe(false);
  // UUID shape (36 chars) — excluded by length cap
  expect(isValidName("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(false);
});

test("isValidName accepts normal names", () => {
  expect(isValidName("calm-fox")).toBe(true);
  expect(isValidName("frontend_tab")).toBe(true);
  expect(isValidName("peer1")).toBe(true);
  expect(isValidName("A-B-C")).toBe(true);
});

test("NAME_REGEX is exported", () => {
  expect(NAME_REGEX).toBeInstanceOf(RegExp);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/names.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Write `shared/names.ts`**

```ts
// shared/names.ts
// Friendly auto-generated peer names + validation.

export const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
export const NAME_MAX_LEN = 32;

const ADJECTIVES = [
  "calm","bold","swift","quiet","loud","bright","fuzzy","sly","brave","tidy",
  "glowy","snappy","mellow","nimble","sturdy","gentle","keen","plush","witty","chill",
  "zesty","peppy","breezy","sunny","dusky","sleek","lofty","spry","chirpy","merry",
  "cozy","crisp","jolly","dapper","suave","spunky","prim","proud","quirky","vivid",
  "zany","lush","balmy","hefty","burly","wispy","rosy","sage","brisk","lively"
];

const NOUNS = [
  "fox","panda","otter","hawk","whale","bison","koala","lynx","robin","heron",
  "moose","falcon","yak","seal","gecko","newt","finch","owl","badger","tiger",
  "wolf","crane","bat","crow","swan","lamb","mole","pony","shark","squid",
  "goose","eel","mantis","toad","cub","drake","stork","vole","wren","raven",
  "puma","zebu","llama","ibis","kiwi","quokka","tapir","dodo","civet","lemur"
];

export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
}

export function isValidName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > NAME_MAX_LEN) return false;
  return NAME_REGEX.test(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/names.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add shared/names.ts tests/names.test.ts
git commit -m "feat: friendly name generator with validation"
```

---

## Task 4: Broker SQLite schema + initializer

**Files:**
- Create: `broker.ts` (skeleton, just DB init — expanded in later tasks)
- Create: `tests/broker-db.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/broker-db.test.ts`:
```ts
import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../broker";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-test-" + Date.now() + ".db";

afterEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

test("initDb creates peers and messages tables with indices", () => {
  const db = initDb(TEST_DB);

  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  expect(tables).toContain("peers");
  expect(tables).toContain("messages");

  const indices = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
  ).all().map(r => r.name);
  expect(indices).toContain("idx_messages_to_acked");
  expect(indices).toContain("idx_peers_last_seen");
  expect(indices).toContain("idx_peers_name");

  const pragma = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(pragma?.journal_mode.toLowerCase()).toBe("wal");

  db.close();
});

test("initDb is idempotent", () => {
  const db1 = initDb(TEST_DB);
  db1.close();
  const db2 = initDb(TEST_DB);
  db2.close();
  // No throws = pass
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/broker-db.test.ts
```
Expected: FAIL (`broker.ts` does not exist).

- [ ] **Step 3: Write `broker.ts` skeleton**

```ts
// broker.ts
// HTTP + SQLite daemon for agent-peers-mcp. Runs on localhost:7900.
// Spec: docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_DB_PATH = resolve(homedir(), ".agent-peers.db");
export const DEFAULT_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);

export function initDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to_acked ON messages(to_id, acked);`);

  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-db.test.ts
```
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/broker-db.test.ts
git commit -m "feat(broker): SQLite schema + initDb with WAL"
```

---

## Task 5: Broker peer CRUD (register/heartbeat/unregister/set-summary)

**Files:**
- Modify: `broker.ts`
- Create: `tests/broker-peers.test.ts`

- [ ] **Step 1: Write failing test**

`tests/broker-peers.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, registerPeer, heartbeatPeer, unregisterPeer, setPeerSummary, getPeer } from "../broker";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
const TEST_DB = "/tmp/agent-peers-peers-" + Date.now() + ".db";

beforeEach(() => { db = initDb(TEST_DB); });
afterEach(() => { db.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

test("registerPeer creates a peer with generated id + name", () => {
  const { id, name } = registerPeer(db, {
    peer_type: "claude", pid: 1234, cwd: "/tmp", git_root: null, tty: null, summary: ""
  });
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(name.length).toBeGreaterThan(0);
  const peer = getPeer(db, id);
  expect(peer?.peer_type).toBe("claude");
  expect(peer?.name).toBe(name);
});

test("registerPeer honors explicit name if provided and unique", () => {
  const { id, name } = registerPeer(db, {
    peer_type: "codex", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", name: "frontend-tab"
  });
  expect(name).toBe("frontend-tab");
  const peer = getPeer(db, id);
  expect(peer?.name).toBe("frontend-tab");
});

test("registerPeer appends -2 on name collision", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", name: "dup" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/a", git_root: null, tty: null, summary: "", name: "dup" });
  expect(a.name).toBe("dup");
  expect(b.name).toBe("dup-2");
});

test("registerPeer is atomic under simulated interleaving (round-2 fix)", () => {
  // We can't trivially drive multi-thread concurrency on bun:sqlite from the test, but we can
  // prove the check-then-write race is closed by inserting a row with name="race"
  // under broker's very nose, then asking the broker to register with name="race" —
  // the broker's atomic INSERT must catch UNIQUE and advance to "race-2".
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("external-id", "race", "claude", 99, "/ext", null, null, "", new Date().toISOString(), new Date().toISOString());

  const res = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", name: "race" });
  expect(res.name).toBe("race-2");
});

test("heartbeatPeer bumps last_seen", async () => {
  const { id } = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "" });
  const initial = getPeer(db, id)!.last_seen;
  await new Promise(r => setTimeout(r, 20));
  heartbeatPeer(db, id);
  const after = getPeer(db, id)!.last_seen;
  expect(after > initial).toBe(true);
});

test("setPeerSummary updates summary", () => {
  const { id } = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "" });
  setPeerSummary(db, id, "Working on X");
  expect(getPeer(db, id)?.summary).toBe("Working on X");
});

test("unregisterPeer removes peer row", () => {
  const { id } = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "" });
  unregisterPeer(db, id);
  expect(getPeer(db, id)).toBeNull();
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/broker-peers.test.ts
```
Expected: FAIL on missing exports.

- [ ] **Step 3: Extend `broker.ts` with peer CRUD (atomic name allocation via INSERT + catch UNIQUE)**

Append to `broker.ts`:
```ts
import { randomUUID } from "node:crypto";
import type {
  RegisterRequest, RegisterResponse, Peer, PeerType,
} from "./shared/types.ts";
import { generateName, isValidName, NAME_MAX_LEN, NAME_REGEX } from "./shared/names.ts";

function nowIso(): string { return new Date().toISOString(); }

function isUniqueViolation(e: unknown): boolean {
  // bun:sqlite surfaces this as an Error with message including "UNIQUE constraint failed"
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

function* nameCandidates(requested: string | undefined): Generator<string> {
  // 1. Explicit + valid → try as-is, then requested-2 ... requested-99
  if (requested && isValidName(requested)) {
    yield requested;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${requested}-${i}`;
      if (candidate.length <= NAME_MAX_LEN) yield candidate;
    }
  }
  // 2. Auto-generate; tight pool, low collision probability
  for (let i = 0; i < 100; i++) yield generateName();
  // 3. Exhaustive fallback with numeric suffix on auto names
  for (let i = 2; i <= 999; i++) {
    const candidate = `${generateName()}-${i}`;
    if (candidate.length <= NAME_MAX_LEN) yield candidate;
  }
}

export function registerPeer(db: Database, req: RegisterRequest): RegisterResponse {
  const id = randomUUID();
  const ts = nowIso();
  const insert = db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const candidate of nameCandidates(req.name)) {
    try {
      insert.run(id, candidate, req.peer_type, req.pid, req.cwd, req.git_root, req.tty, req.summary, ts, ts);
      return { id, name: candidate };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // UNIQUE violation → name taken, advance to next candidate
    }
  }
  throw new Error("broker: unable to allocate unique peer name after exhaustive retry");
}

export function heartbeatPeer(db: Database, id: string): void {
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(nowIso(), id);
}

export function unregisterPeer(db: Database, id: string): void {
  db.query("DELETE FROM peers WHERE id = ?").run(id);
  // Note: undelivered messages addressed to this peer are intentionally left in the
  // DB as orphans (observable via cli.ts orphaned-messages). This matches the
  // honest best-effort delivery contract — see spec §5.1.
}

export function setPeerSummary(db: Database, id: string, summary: string): void {
  db.query("UPDATE peers SET summary = ?, last_seen = ? WHERE id = ?").run(summary, nowIso(), id);
}

export function getPeer(db: Database, id: string): Peer | null {
  const row = db.query<Peer, [string]>("SELECT * FROM peers WHERE id = ?").get(id);
  return row ?? null;
}

export function getPeerByName(db: Database, name: string): Peer | null {
  const row = db.query<Peer, [string]>("SELECT * FROM peers WHERE name = ?").get(name);
  return row ?? null;
}

// Re-exports so callers have one import surface
export { NAME_REGEX, NAME_MAX_LEN, isValidName };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-peers.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/broker-peers.test.ts
git commit -m "feat(broker): peer CRUD with collision-resolving name allocation"
```

---

## Task 6: Broker list_peers with filters + scope

**Files:**
- Modify: `broker.ts`
- Create: `tests/broker-list.test.ts`

- [ ] **Step 1: Write failing test**

`tests/broker-list.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, registerPeer, listPeers } from "../broker";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
const TEST_DB = "/tmp/agent-peers-list-" + Date.now() + ".db";
beforeEach(() => { db = initDb(TEST_DB); });
afterEach(() => { db.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

test("listPeers scope=machine returns all peers minus excluded", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: "/g", tty: null, summary: "" });
  const b = registerPeer(db, { peer_type: "codex",  pid: 2, cwd: "/b", git_root: "/h", tty: null, summary: "" });
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null, exclude_id: a.id });
  expect(peers.map(p => p.id)).toEqual([b.id]);
});

test("listPeers scope=directory filters by cwd", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/y", git_root: null, tty: null, summary: "" });
  const peers = listPeers(db, { scope: "directory", cwd: "/x", git_root: null });
  expect(peers.map(p => p.id)).toEqual([a.id]);
});

test("listPeers scope=repo filters by git_root", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x/sub", git_root: "/x", tty: null, summary: "" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/y",     git_root: "/y", tty: null, summary: "" });
  const peers = listPeers(db, { scope: "repo", cwd: "/x", git_root: "/x" });
  expect(peers.map(p => p.id)).toEqual([a.id]);
});

test("listPeers peer_type filter", () => {
  registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "" });
  const c = registerPeer(db, { peer_type: "codex", pid: 2, cwd: "/a", git_root: null, tty: null, summary: "" });
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null, peer_type: "codex" });
  expect(peers.map(p => p.id)).toEqual([c.id]);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/broker-list.test.ts
```
Expected: FAIL (missing `listPeers`).

- [ ] **Step 3: Add `listPeers` to `broker.ts`**

Append to `broker.ts`:
```ts
import type { ListPeersRequest } from "./shared/types.ts";

export function listPeers(db: Database, req: ListPeersRequest): Peer[] {
  const clauses: string[] = [];
  const params: (string | null)[] = [];

  if (req.scope === "directory") {
    clauses.push("cwd = ?");
    params.push(req.cwd);
  } else if (req.scope === "repo") {
    if (req.git_root) {
      clauses.push("git_root = ?");
      params.push(req.git_root);
    } else {
      // fallback: if caller has no git root, use cwd equality so scope stays meaningful
      clauses.push("cwd = ?");
      params.push(req.cwd);
    }
  }
  // scope === "machine" adds no filter

  if (req.exclude_id) {
    clauses.push("id != ?");
    params.push(req.exclude_id);
  }
  if (req.peer_type) {
    clauses.push("peer_type = ?");
    params.push(req.peer_type);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM peers ${where} ORDER BY last_seen DESC`;
  return db.query<Peer, typeof params>(sql).all(...params);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-list.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/broker-list.test.ts
git commit -m "feat(broker): listPeers with scope + peer_type filters"
```

---

## Task 7: Broker send_message + target-name resolution + liveness

**Files:**
- Modify: `broker.ts`
- Create: `tests/broker-send.test.ts`

- [ ] **Step 1: Write failing test**

`tests/broker-send.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, registerPeer, sendMessage, heartbeatPeer } from "../broker";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
const TEST_DB = "/tmp/agent-peers-send-" + Date.now() + ".db";
beforeEach(() => { db = initDb(TEST_DB); });
afterEach(() => { db.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

function mkPeer(name?: string) {
  return registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "",
    ...(name ? { name } : {}),
  });
}

test("sendMessage by id stores message and returns ok+message_id", () => {
  const a = mkPeer("alpha");
  const b = mkPeer("beta");
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: b.id, text: "hi" });
  expect(res.ok).toBe(true);
  expect(typeof res.message_id).toBe("number");
});

test("sendMessage by name resolves to id", () => {
  const a = mkPeer("alpha");
  const b = mkPeer("beta");
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "hi" });
  expect(res.ok).toBe(true);
});

test("sendMessage unknown peer returns ok=false", () => {
  const a = mkPeer("alpha");
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: "nobody", text: "hi" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unknown peer/i);
});

test("sendMessage to stale peer rejects with 'target peer stale'", () => {
  const a = mkPeer("alpha");
  const b = mkPeer("beta");
  // Force beta stale by backdating last_seen
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", b.id);
  const res = sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "hi" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/stale/i);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/broker-send.test.ts
```
Expected: FAIL (missing `sendMessage`).

- [ ] **Step 3: Add `sendMessage` to `broker.ts`**

Append:
```ts
import type { SendMessageRequest, SendMessageResponse } from "./shared/types.ts";

export const STALE_THRESHOLD_MS = 60_000;

function isStale(last_seen_iso: string): boolean {
  const t = Date.parse(last_seen_iso);
  return !Number.isFinite(t) || (Date.now() - t) > STALE_THRESHOLD_MS;
}

function resolveTarget(db: Database, to_id_or_name: string): Peer | null {
  // Try id first (cheap)
  const byId = getPeer(db, to_id_or_name);
  if (byId) return byId;
  // Fall back to name
  return getPeerByName(db, to_id_or_name);
}

export function sendMessage(db: Database, req: SendMessageRequest): SendMessageResponse {
  const target = resolveTarget(db, req.to_id_or_name);
  if (!target) return { ok: false, error: `unknown peer: ${req.to_id_or_name}` };
  if (isStale(target.last_seen)) return { ok: false, error: `target peer stale: ${target.name}` };

  const result = db.query<{ id: number }, [string, string, string, string]>(
    `INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?) RETURNING id`
  ).get(req.from_id, target.id, req.text, nowIso());

  return { ok: true, message_id: result?.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-send.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/broker-send.test.ts
git commit -m "feat(broker): sendMessage with name-or-id + liveness check"
```

---

## Task 8: Broker poll-messages with leasing

**Files:**
- Modify: `broker.ts`
- Create: `tests/broker-poll.test.ts`

- [ ] **Step 1: Write failing test**

`tests/broker-poll.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, registerPeer, sendMessage, pollMessages } from "../broker";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
const TEST_DB = "/tmp/agent-peers-poll-" + Date.now() + ".db";
beforeEach(() => { db = initDb(TEST_DB); });
afterEach(() => { db.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

function mkPeers() {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta"  });
  return { a, b };
}

test("pollMessages returns leased messages with enriched from fields", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "ping" });
  const out = pollMessages(db, b.id);
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("ping");
  expect(out[0]!.from_name).toBe("alpha");
  expect(out[0]!.from_peer_type).toBe("claude");
  expect(out[0]!.lease_token).toMatch(/^[a-f0-9-]{36}$/);
});

test("pollMessages twice does not re-deliver while lease active", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "once" });
  expect(pollMessages(db, b.id).length).toBe(1);
  expect(pollMessages(db, b.id).length).toBe(0); // still leased
});

test("pollMessages re-delivers after lease expiry", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "once" });
  const first = pollMessages(db, b.id);
  expect(first.length).toBe(1);
  // Force lease to have already expired
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", first[0]!.id);
  const second = pollMessages(db, b.id);
  expect(second.length).toBe(1);
  // Lease token must change on re-delivery
  expect(second[0]!.lease_token).not.toBe(first[0]!.lease_token);
});

test("pollMessages heartbeat is rolled back if tx throws (round-4 fix)", () => {
  const { a, b } = mkPeers();
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "once" });

  // Backdate last_seen so we can observe whether the heartbeat fires
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", b.id);
  const before = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;

  // Force the SELECT inside the tx to fail by temporarily dropping the index it uses.
  // (SELECT still works without the index, so we need a harsher trick: rename the
  // messages table mid-transaction from a trigger-prepared corruption. Instead we
  // use the simpler approach: feed pollMessages a non-existent peer id AFTER dropping
  // the messages table, then restore it.)
  db.exec("ALTER TABLE messages RENAME TO messages_bak");
  try {
    expect(() => pollMessages(db, b.id)).toThrow();
  } finally {
    db.exec("ALTER TABLE messages_bak RENAME TO messages");
  }

  // Heartbeat was inside the tx → rolled back with the failing SELECT.
  const after = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;
  expect(after).toBe(before);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/broker-poll.test.ts
```
Expected: FAIL (missing `pollMessages`).

- [ ] **Step 3: Add `pollMessages` to `broker.ts`**

Append:
```ts
import type { LeasedMessage } from "./shared/types.ts";

export const LEASE_DURATION_MS = 30_000;

export function pollMessages(db: Database, id: string): LeasedMessage[] {
  const now = new Date();
  const nowStr = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  // Single transaction: heartbeat + lease selection + lease update. The heartbeat
  // MUST live inside the transaction so a poll that throws mid-way does NOT
  // refresh last_seen — otherwise a broken session stays "alive" in the broker's
  // eyes and never gets GC'd (Codex review round-4 fix).
  const tx = db.transaction(() => {
    // Liveness bump inside tx → rolls back on any failure below
    db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(nowStr, id);

    const rows = db.query<
      { id: number; from_id: string; to_id: string; text: string; sent_at: string },
      [string, string, string]
    >(
      `SELECT id, from_id, to_id, text, sent_at
       FROM messages
       WHERE to_id = ? AND acked = 0
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
       ORDER BY id ASC`
    ).all(id, nowStr, nowStr);

    const result: LeasedMessage[] = [];
    for (const row of rows) {
      const lease = crypto.randomUUID();
      db.query("UPDATE messages SET lease_token = ?, lease_expires_at = ? WHERE id = ?")
        .run(lease, leaseUntil, row.id);
      const sender = getPeer(db, row.from_id);
      result.push({
        id: row.id,
        from_id: row.from_id,
        from_name: sender?.name ?? "(gone)",
        from_peer_type: (sender?.peer_type ?? "claude") as "claude" | "codex",
        from_cwd: sender?.cwd ?? "",
        from_summary: sender?.summary ?? "",
        to_id: row.to_id,
        text: row.text,
        sent_at: row.sent_at,
        lease_token: lease,
      });
    }
    return result;
  });

  return tx();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-poll.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/broker-poll.test.ts
git commit -m "feat(broker): poll-messages with lease allocation"
```

---

## Task 9: Broker ack-messages + rename-peer + GC

**Files:**
- Modify: `broker.ts`
- Create: `tests/broker-ack-rename-gc.test.ts`

- [ ] **Step 1: Write failing test**

`tests/broker-ack-rename-gc.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  initDb, registerPeer, sendMessage, pollMessages, ackMessages,
  renamePeer, gcStalePeers, listOrphanedMessages, getPeer, getPeerByName,
} from "../broker";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
const TEST_DB = "/tmp/agent-peers-ack-" + Date.now() + ".db";
beforeEach(() => { db = initDb(TEST_DB); });
afterEach(() => { db.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

test("ackMessages marks matching rows as acked; later polls skip them", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "a" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "b" });
  sendMessage(db, { from_id: a.id, to_id_or_name: "b", text: "m" });
  const leased = pollMessages(db, b.id);
  const res = ackMessages(db, { id: b.id, lease_tokens: leased.map(m => m.lease_token) });
  expect(res.acked).toBe(1);
  // Force lease expiry — should still NOT re-deliver because acked=1
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  expect(pollMessages(db, b.id).length).toBe(0);
});

test("ackMessages REJECTS late acks whose lease has already expired (round-2 fix)", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "a" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "b" });
  sendMessage(db, { from_id: a.id, to_id_or_name: "b", text: "m" });
  const leased = pollMessages(db, b.id);
  // Force lease to be in the past
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  // Late ack arrives
  const res = ackMessages(db, { id: b.id, lease_tokens: leased.map(m => m.lease_token) });
  expect(res.acked).toBe(0); // predicate rejected the stale lease
  // Message should therefore still be deliverable
  const redelivered = pollMessages(db, b.id);
  expect(redelivered.length).toBe(1);
});

test("renamePeer to new unique name succeeds; duplicate rejects; invalid rejects", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta"  });

  const ok = renamePeer(db, { id: a.id, new_name: "gamma" });
  expect(ok.ok).toBe(true);
  expect(ok.name).toBe("gamma");
  expect(getPeerByName(db, "gamma")?.id).toBe(a.id);

  const dup = renamePeer(db, { id: a.id, new_name: "beta" });
  expect(dup.ok).toBe(false);
  expect(dup.error).toMatch(/taken/i);

  const bad = renamePeer(db, { id: a.id, new_name: "has space" });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/invalid/i);
});

test("gcStalePeers removes peer rows but PRESERVES undelivered messages as orphans (round-2 fix)", () => {
  const a = registerPeer(db, { peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "alpha" });
  const b = registerPeer(db, { peer_type: "claude", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "beta" });
  sendMessage(db, { from_id: a.id, to_id_or_name: "beta", text: "you will die before reading this" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", b.id);
  const removed = gcStalePeers(db);
  expect(removed).toBe(1);
  expect(getPeer(db, b.id)).toBeNull();
  // Message is still in the DB (orphaned) — observable via listOrphanedMessages
  const remaining = db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM messages WHERE to_id = ?").get(b.id);
  expect(remaining?.c).toBe(1);
  const orphans = listOrphanedMessages(db);
  expect(orphans.length).toBe(1);
  expect(orphans[0]!.to_id).toBe(b.id);
  expect(orphans[0]!.text).toBe("you will die before reading this");
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/broker-ack-rename-gc.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add ack/rename/gc/orphan functions to `broker.ts`**

Append:
```ts
import type { AckMessagesRequest, AckMessagesResponse, RenamePeerRequest, RenamePeerResponse } from "./shared/types.ts";

export function ackMessages(db: Database, req: AckMessagesRequest): AckMessagesResponse {
  if (req.lease_tokens.length === 0) return { ok: true, acked: 0 };
  const placeholders = req.lease_tokens.map(() => "?").join(",");
  // Reject stale acks: lease must not be expired at this moment.
  const sql = `UPDATE messages SET acked = 1, lease_token = NULL, lease_expires_at = NULL
               WHERE lease_token IN (${placeholders})
                 AND to_id = ?
                 AND acked = 0
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at >= ?`;
  const info = db.query(sql).run(...req.lease_tokens, req.id, nowIso());
  return { ok: true, acked: (info as any).changes ?? 0 };
}

export function renamePeer(db: Database, req: RenamePeerRequest): RenamePeerResponse {
  if (!isValidName(req.new_name)) return { ok: false, error: "invalid name" };
  try {
    const info = db.query("UPDATE peers SET name = ?, last_seen = ? WHERE id = ?")
      .run(req.new_name, nowIso(), req.id);
    if (((info as any).changes ?? 0) === 0) return { ok: false, error: "unknown peer" };
    return { ok: true, name: req.new_name };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "name taken" };
    throw e;
  }
}

export function gcStalePeers(db: Database): number {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const tx = db.transaction(() => {
    const stale = db.query<{ id: string }, [string]>("SELECT id FROM peers WHERE last_seen < ?").all(cutoff);
    for (const row of stale) {
      // Intentionally do NOT delete unacked messages — spec §5.1 orphan-preserving GC.
      db.query("DELETE FROM peers WHERE id = ?").run(row.id);
    }
    return stale.length;
  });
  return tx();
}

// Orphans: undelivered messages whose to_id no longer matches any active peer.
export interface OrphanMessage {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
}

export function listOrphanedMessages(db: Database): OrphanMessage[] {
  return db.query<OrphanMessage, []>(
    `SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at
     FROM messages m
     LEFT JOIN peers p ON p.id = m.to_id
     WHERE p.id IS NULL AND m.acked = 0
     ORDER BY m.id ASC`
  ).all();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-ack-rename-gc.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/broker-ack-rename-gc.test.ts
git commit -m "feat(broker): ack, rename, gc stale peers"
```

---

## Task 10: Broker HTTP server (`Bun.serve`) + main()

**Files:**
- Modify: `broker.ts`

- [ ] **Step 1: Add HTTP server to `broker.ts`**

Append:
```ts
// ----- HTTP layer -----

async function readJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

export function startBroker(port: number, dbPath: string) {
  const db = initDb(dbPath);

  // Timer-driven GC — runs every 30s
  const gcTimer = setInterval(() => {
    try { gcStalePeers(db); } catch (e) { console.error("[broker] GC error:", e); }
  }, 30_000);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return json({ ok: true, pid: process.pid });
        }
        if (req.method !== "POST") return json({ error: "method not allowed" }, { status: 405 });

        switch (url.pathname) {
          case "/register":      return json(registerPeer(db, await readJson(req)));
          case "/heartbeat":     { const { id } = await readJson<{ id: string }>(req); heartbeatPeer(db, id); return json({ ok: true }); }
          case "/unregister":    { const { id } = await readJson<{ id: string }>(req); unregisterPeer(db, id); return json({ ok: true }); }
          case "/set-summary":   { const { id, summary } = await readJson<{ id: string; summary: string }>(req); setPeerSummary(db, id, summary); return json({ ok: true }); }
          case "/list-peers":    return json(listPeers(db, await readJson(req)));
          case "/send-message":  return json(sendMessage(db, await readJson(req)));
          case "/poll-messages": { const { id } = await readJson<{ id: string }>(req); return json({ messages: pollMessages(db, id) }); }
          case "/ack-messages":  return json(ackMessages(db, await readJson(req)));
          case "/rename-peer":   return json(renamePeer(db, await readJson(req)));
          default: return json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        console.error("[broker] request error:", e);
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    },
  });

  const cleanup = () => {
    clearInterval(gcTimer);
    server.stop(true);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.error(`[broker] listening on http://127.0.0.1:${port}, db=${dbPath}, pid=${process.pid}`);
  return { server, db, gcTimer };
}

// Only run as daemon when invoked directly (not when imported by tests).
if (import.meta.main) {
  startBroker(DEFAULT_PORT, process.env.AGENT_PEERS_DB || DEFAULT_DB_PATH);
}
```

- [ ] **Step 2: Smoke-start the broker**

In terminal 1:
```bash
bun broker.ts
```
Expected log: `[broker] listening on http://127.0.0.1:7900`

- [ ] **Step 3: In terminal 2, hit `/health`**

```bash
curl -s http://127.0.0.1:7900/health
```
Expected: `{"ok":true,"pid":<number>}`

- [ ] **Step 4: Kill broker in terminal 1 (Ctrl-C)**

- [ ] **Step 5: Commit**

```bash
git add broker.ts
git commit -m "feat(broker): HTTP server + timer GC + startup wiring"
```

---

## Task 11: `shared/broker-client.ts`

**Files:**
- Create: `shared/broker-client.ts`
- Create: `tests/broker-client.test.ts`

- [ ] **Step 1: Write failing test**

`tests/broker-client.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker";
import { createClient } from "../shared/broker-client";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-client-" + Date.now() + ".db";
const TEST_PORT = 7911;
let handle: ReturnType<typeof startBroker>;

beforeAll(() => { handle = startBroker(TEST_PORT, TEST_DB); });
afterAll(async () => {
  handle.gcTimer && clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

test("broker-client end-to-end: register, send, poll, ack", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`);

  const a = await client.register({ peer_type: "claude", pid: 10, cwd: "/a", git_root: null, tty: null, summary: "", name: "alpha" });
  const b = await client.register({ peer_type: "codex",  pid: 11, cwd: "/a", git_root: null, tty: null, summary: "", name: "beta" });
  expect(a.name).toBe("alpha");
  expect(b.name).toBe("beta");

  const sent = await client.sendMessage({ from_id: a.id, to_id_or_name: "beta", text: "hi" });
  expect(sent.ok).toBe(true);

  const polled = await client.pollMessages(b.id);
  expect(polled.length).toBe(1);
  expect(polled[0]!.from_name).toBe("alpha");

  const acked = await client.ackMessages({ id: b.id, lease_tokens: polled.map(m => m.lease_token) });
  expect(acked.acked).toBe(1);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/broker-client.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `shared/broker-client.ts`**

```ts
// shared/broker-client.ts
// Typed HTTP wrapper. Used by both MCP servers + cli.ts.

import type {
  RegisterRequest, RegisterResponse, SetSummaryRequest, ListPeersRequest,
  SendMessageRequest, SendMessageResponse, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse, LeasedMessage, Peer, PeerId,
} from "./types.ts";

export interface BrokerClient {
  isAlive(): Promise<boolean>;
  register(req: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(id: PeerId): Promise<void>;
  unregister(id: PeerId): Promise<void>;
  setSummary(req: SetSummaryRequest): Promise<void>;
  listPeers(req: ListPeersRequest): Promise<Peer[]>;
  sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  pollMessages(id: PeerId): Promise<LeasedMessage[]>;
  ackMessages(req: AckMessagesRequest): Promise<AckMessagesResponse>;
  renamePeer(req: RenamePeerRequest): Promise<RenamePeerResponse>;
}

export function createClient(baseUrl: string): BrokerClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`broker ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  return {
    async isAlive() {
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch { return false; }
    },
    register(req) { return post<RegisterResponse>("/register", req); },
    async heartbeat(id) { await post("/heartbeat", { id }); },
    async unregister(id) { await post("/unregister", { id }); },
    async setSummary(req) { await post("/set-summary", req); },
    listPeers(req) { return post<Peer[]>("/list-peers", req); },
    sendMessage(req) { return post<SendMessageResponse>("/send-message", req); },
    async pollMessages(id) {
      const { messages } = await post<{ messages: LeasedMessage[] }>("/poll-messages", { id });
      return messages;
    },
    ackMessages(req) { return post<AckMessagesResponse>("/ack-messages", req); },
    renamePeer(req) { return post<RenamePeerResponse>("/rename-peer", req); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/broker-client.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/broker-client.ts tests/broker-client.test.ts
git commit -m "feat(shared): typed broker HTTP client"
```

---

## Task 12: `shared/ensure-broker.ts` + path resolution

**Files:**
- Create: `shared/ensure-broker.ts`

- [ ] **Step 1: Write `shared/ensure-broker.ts`**

```ts
// shared/ensure-broker.ts
// Ensures the broker daemon is running. Spawns it detached if not.

import { fileURLToPath } from "node:url";
import { BrokerClient } from "./broker-client.ts";

export async function ensureBroker(
  client: BrokerClient,
  brokerScriptUrl: string,  // pass import.meta.url-relative URL from caller
): Promise<void> {
  if (await client.isAlive()) return;

  // Resolve script path via fileURLToPath — required because the project path
  // contains a space AND an apostrophe ("Brayden's Projects"), which URL.pathname
  // returns URL-encoded. Spawn would ENOENT the encoded form.
  const scriptPath = fileURLToPath(brokerScriptUrl);

  const proc = Bun.spawn(["bun", scriptPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await client.isAlive()) return;
  }
  throw new Error("ensureBroker: broker did not come up within 6s");
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add shared/ensure-broker.ts
git commit -m "feat(shared): ensureBroker with fileURLToPath-safe resolution"
```

---

## Task 13: `shared/peer-context.ts` (git root, tty, pid)

**Files:**
- Create: `shared/peer-context.ts`

- [ ] **Step 1: Write `shared/peer-context.ts`**

```ts
// shared/peer-context.ts
// Best-effort process metadata for peer registration.

export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd, stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : null;
  } catch { return null; }
}

export function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    if (tty && tty !== "?" && tty !== "??") return tty;
    return null;
  } catch { return null; }
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add shared/peer-context.ts
git commit -m "feat(shared): peer context helpers"
```

---

## Task 14: `shared/tab-title.ts` (OSC escape writer)

**Files:**
- Create: `shared/tab-title.ts`

- [ ] **Step 1: Write `shared/tab-title.ts`**

```ts
// shared/tab-title.ts
// Best-effort terminal tab title updater via OSC 0 escape.

import { openSync, writeSync, closeSync } from "node:fs";

export function setTabTitle(title: string): void {
  if (process.env.AGENT_PEERS_DISABLE_TAB_TITLE === "1") return;
  const safe = title.replace(/[\x00-\x1f\x7f]/g, ""); // strip control chars
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, `\x1b]0;${safe}\x07`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // No controlling TTY, permission denied, closed pty, etc. — non-fatal.
    console.error(`[agent-peers] tab title write failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add shared/tab-title.ts
git commit -m "feat(shared): OSC tab title helper"
```

---

## Task 15: `shared/summarize.ts` (gpt-5.4-nano auto-summary)

**Files:**
- Create: `shared/summarize.ts`

- [ ] **Step 1: Write `shared/summarize.ts`**

```ts
// shared/summarize.ts
// Optional auto-summary of what a peer is working on, via gpt-5.4-nano.
// If OPENAI_API_KEY is unset, returns empty string (non-fatal).

export interface SummaryInput {
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  recent_files: string[];
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "branch", "--show-current"], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() || null : null;
  } catch { return null; }
}

export async function getRecentFiles(cwd: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      ["git", "log", "--name-only", "--pretty=format:", "-n", "10"],
      { cwd, stdout: "pipe", stderr: "ignore" }
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return [];
    const uniq = new Set(text.split("\n").map(s => s.trim()).filter(Boolean));
    return Array.from(uniq).slice(0, 20);
  } catch { return []; }
}

export async function generateSummary(input: SummaryInput): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "";

  const prompt = `Summarize in one sentence what a developer is probably working on, based on this context.
CWD: ${input.cwd}
Git root: ${input.git_root ?? "(none)"}
Branch: ${input.git_branch ?? "(none)"}
Recent files: ${input.recent_files.join(", ") || "(none)"}
Return only the summary sentence, no preamble.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add shared/summarize.ts
git commit -m "feat(shared): optional gpt-5.4-nano auto-summary"
```

---

## Task 16: `shared/piggyback.ts` (Codex inbox-block formatter)

**Files:**
- Create: `shared/piggyback.ts`
- Create: `tests/piggyback.test.ts`

- [ ] **Step 1: Write failing test**

`tests/piggyback.test.ts`:
```ts
import { test, expect } from "bun:test";
import { formatInboxBlock } from "../shared/piggyback";
import type { LeasedMessage } from "../shared/types";

const m = (id: number, text: string, from_name = "alpha"): LeasedMessage => ({
  id, from_id: "id-" + id, from_name, from_peer_type: "claude",
  from_cwd: "/x", from_summary: "", to_id: "me",
  text, sent_at: "2026-04-13T00:00:00.000Z", lease_token: "tok-" + id,
});

test("formatInboxBlock returns empty string for no messages", () => {
  expect(formatInboxBlock([])).toBe("");
});

test("formatInboxBlock includes reply hint with first from_name + message_id + body", () => {
  const out = formatInboxBlock([m(42, "ping")]);
  expect(out).toContain("[PEER INBOX]");
  expect(out).toContain("respond to each via send_message");
  expect(out).toContain("message_id: 42");
  expect(out).toContain("from: alpha");
  expect(out).toContain("ping");
});

test("formatInboxBlock numbers multiple messages", () => {
  const out = formatInboxBlock([m(1, "a"), m(2, "b", "beta")]);
  expect(out).toContain("msg 1 of 2");
  expect(out).toContain("msg 2 of 2");
  expect(out).toContain("from: alpha");
  expect(out).toContain("from: beta");
});
```

- [ ] **Step 2: Run to verify fail**

```bash
bun test tests/piggyback.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `shared/piggyback.ts`**

```ts
// shared/piggyback.ts
// Builds the [PEER INBOX] block injected into Codex tool responses.

import type { LeasedMessage } from "./types.ts";

export function formatInboxBlock(messages: LeasedMessage[]): string {
  if (messages.length === 0) return "";

  const header =
    `[PEER INBOX] ${messages.length} new peer message(s) — ` +
    `respond to each via send_message(to_id=<from_name>, message="...")\n`;

  const blocks = messages.map((m, i) => [
    `--- msg ${i + 1} of ${messages.length} ---`,
    `message_id: ${m.id}`,
    `from: ${m.from_name} (${m.from_peer_type}, cwd=${m.from_cwd})`,
    `sent_at: ${m.sent_at}`,
    `text:`,
    m.text,
  ].join("\n"));

  return [header, ...blocks, "--- end peer inbox ---", ""].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/piggyback.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/piggyback.ts tests/piggyback.test.ts
git commit -m "feat(shared): piggyback inbox-block formatter"
```

---

## Task 17: `claude-server.ts` — registration + heartbeat + tools (no push yet)

**Files:**
- Create: `claude-server.ts`

- [ ] **Step 1: Write `claude-server.ts` skeleton with tools (push added in Task 18)**

```ts
#!/usr/bin/env bun
// claude-server.ts
// MCP stdio server for Claude Code; registers as peer_type="claude", declares claude/channel.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle } from "./shared/tab-title.ts";
import { isValidName } from "./shared/names.ts";
import type { PeerId } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) { console.error(`[agent-peers/claude] ${msg}`); }

const client = createClient(BROKER_URL);

let myId: PeerId | null = null;
let myName: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
`You are connected to the agent-peers network. Other AI agents on this machine (Claude Code or Codex CLI) can see you and send you messages.

IMPORTANT: When you receive a <channel source="agent-peers" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply via send_message with the sender's from_id (or from_name), then resume.

On startup, proactively call set_summary with a 1-2 sentence description of your work.

Available tools:
- list_peers(scope: machine|directory|repo, peer_type?)
- send_message(to_id, message)  // to_id accepts a peer UUID or a human name
- set_summary(summary)
- check_messages  // manual inbox check (usually unnecessary thanks to channel push)
- rename_peer(new_name)  // renames YOU; 1-32 chars, [a-zA-Z0-9_-]`
  }
);

const TOOLS = [
  { name: "list_peers", description: "List other AI agent peers on this machine. Returns id, human name, peer_type (claude|codex), cwd, summary.",
    inputSchema: { type: "object" as const, properties: {
      scope: { type: "string" as const, enum: ["machine", "directory", "repo"] },
      peer_type: { type: "string" as const, enum: ["claude", "codex"], description: "optional filter" },
    }, required: ["scope"] } },
  { name: "send_message", description: "Send a message to a peer. to_id accepts either the peer's UUID or their human name (e.g. 'frontend-tab').",
    inputSchema: { type: "object" as const, properties: {
      to_id: { type: "string" as const }, message: { type: "string" as const },
    }, required: ["to_id", "message"] } },
  { name: "set_summary", description: "Set a 1-2 sentence summary of your current work (visible to peers).",
    inputSchema: { type: "object" as const, properties: { summary: { type: "string" as const } }, required: ["summary"] } },
  { name: "check_messages", description: "Manually check inbox. Normally unnecessary — messages push via channel.",
    inputSchema: { type: "object" as const, properties: {} } },
  { name: "rename_peer", description: "Rename YOURSELF. new_name must be 1-32 chars, matching [a-zA-Z0-9_-]. Names must be unique among active peers.",
    inputSchema: { type: "object" as const, properties: { new_name: { type: "string" as const } }, required: ["new_name"] } },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };

  switch (name) {
    case "list_peers": {
      const { scope, peer_type } = args as { scope: "machine" | "directory" | "repo"; peer_type?: "claude" | "codex" };
      const peers = await client.listPeers({ scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId, peer_type });
      if (peers.length === 0) return { content: [{ type: "text" as const, text: `No other peers found (scope: ${scope}).` }] };
      const lines = peers.map(p => [
        `Peer ${p.name} (${p.peer_type})`,
        `  ID: ${p.id}`,
        `  CWD: ${p.cwd}`,
        p.tty ? `  TTY: ${p.tty}` : null,
        p.summary ? `  Summary: ${p.summary}` : null,
        `  Last seen: ${p.last_seen}`,
      ].filter(Boolean).join("\n"));
      return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` }] };
    }
    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      const res = await client.sendMessage({ from_id: myId, to_id_or_name: to_id, text: message });
      if (!res.ok) return { content: [{ type: "text" as const, text: `Send failed: ${res.error}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Message sent (id=${res.message_id}).` }] };
    }
    case "set_summary": {
      const { summary } = args as { summary: string };
      await client.setSummary({ id: myId, summary });
      return { content: [{ type: "text" as const, text: `Summary set: "${summary}"` }] };
    }
    case "check_messages": {
      // Deliberately do NOT poll+ack inside this handler (Codex review round-3 fix —
      // that would ack before the tool response is confirmed delivered to Claude).
      // The background polling loop (started in Task 18) owns delivery + ack via the
      // channel push path, which is the one place ack actually happens and is
      // gated on successful mcp.notification() resolution. This tool is a passive
      // "prompt the model that it's okay" helper — nothing to do here.
      return { content: [{ type: "text" as const, text: "Messages arrive automatically via the agent-peers channel. If you have not seen one recently, none are pending." }] };
    }
    case "rename_peer": {
      const { new_name } = args as { new_name: string };
      if (!isValidName(new_name)) return { content: [{ type: "text" as const, text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.` }], isError: true };
      const res = await client.renamePeer({ id: myId, new_name });
      if (!res.ok) return { content: [{ type: "text" as const, text: `Rename failed: ${res.error}` }], isError: true };
      myName = res.name ?? new_name;
      setTabTitle(`peer:${myName}`);
      return { content: [{ type: "text" as const, text: `Renamed to ${myName}` }] };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  // Ensure broker
  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(client, brokerScriptUrl);

  // Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // Best-effort summary (non-blocking, 3s cap)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const [branch, recent_files] = await Promise.all([getGitBranch(myCwd), getRecentFiles(myCwd)]);
      initialSummary = await generateSummary({ cwd: myCwd, git_root: myGitRoot, git_branch: branch, recent_files });
    } catch { /* non-critical */ }
  })();
  await Promise.race([summaryPromise, new Promise(r => setTimeout(r, 3000))]);

  // Register
  const reg = await client.register({
    peer_type: "claude",
    name: process.env.PEER_NAME,
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  myName = reg.name;
  setTabTitle(`peer:${myName}`);
  log(`Registered as ${myName} (id=${myId})`);

  // Late summary upload
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try { await client.setSummary({ id: myId, summary: initialSummary }); } catch { /* non-critical */ }
      }
    });
  }

  // MCP
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // Heartbeat
  const hb = setInterval(async () => {
    if (myId) { try { await client.heartbeat(myId); } catch { /* non-critical */ } }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(hb);
    if (myId) { try { await client.unregister(myId); } catch { /* best effort */ } }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(e => { log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add claude-server.ts
git commit -m "feat(claude-server): register, tools, heartbeat (push in next task)"
```

---

## Task 18: `claude-server.ts` — push loop + ack

**Files:**
- Modify: `claude-server.ts`

- [ ] **Step 1: Add a polling loop that pushes via channel with seen-set dedupe, then acks**

Insert after the `// MCP` block in `main()` (before the heartbeat block):

```ts
  // In-memory dedupe: message_ids we have already pushed successfully this session.
  // See spec §5.4 for rationale — deterministic dedupe, no model intelligence required.
  const seen = new Set<number>();

  const pollAndPush = async () => {
    if (!myId) return;
    try {
      const msgs = await client.pollMessages(myId);
      const toAck: string[] = [];
      for (const m of msgs) {
        if (seen.has(m.id)) {
          // Re-delivery after a lost ack. Queue the new lease_token so the broker can close
          // the stuck lease, but DO NOT push again.
          toAck.push(m.lease_token);
          continue;
        }
        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: m.text,
              meta: {
                source: "agent-peers",
                message_id: m.id,
                from_id: m.from_id,
                from_name: m.from_name,
                from_peer_type: m.from_peer_type,
                from_summary: m.from_summary,
                from_cwd: m.from_cwd,
                sent_at: m.sent_at,
              },
            },
          });
          // Mark delivered in seen BEFORE ack so a later ack failure cannot cause a re-push.
          seen.add(m.id);
          toAck.push(m.lease_token);
        } catch (e) {
          log(`push failed (lease will expire + redeliver): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (toAck.length > 0) {
        try { await client.ackMessages({ id: myId, lease_tokens: toAck }); } catch { /* next poll picks up remainder */ }
      }
    } catch (e) {
      log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const pushTimer = setInterval(pollAndPush, POLL_INTERVAL_MS);
```

And update `cleanup` to clear the push timer:
```ts
  const cleanup = async () => {
    clearInterval(hb);
    clearInterval(pushTimer);
    if (myId) { try { await client.unregister(myId); } catch { /* best effort */ } }
    process.exit(0);
  };
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add claude-server.ts
git commit -m "feat(claude-server): channel push + ack loop"
```

---

## Task 19: `codex-server.ts` — full (register + piggyback-wrapped tools)

**Files:**
- Create: `codex-server.ts`

- [ ] **Step 1: Write `codex-server.ts`**

```ts
#!/usr/bin/env bun
// codex-server.ts
// MCP stdio server for Codex CLI; registers as peer_type="codex", no channel push,
// delivery via piggyback on every tool response.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle } from "./shared/tab-title.ts";
import { formatInboxBlock } from "./shared/piggyback.ts";
import { isValidName } from "./shared/names.ts";
import type { PeerId, LeasedMessage } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) { console.error(`[agent-peers/codex] ${msg}`); }

const client = createClient(BROKER_URL);

let myId: PeerId | null = null;
let myName: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
`You are connected to the agent-peers network. Other AI agents on this machine (Claude Code or Codex CLI) can see you and send you messages.

When you call any tool on this server, pending peer messages will be prepended to the response inside a [PEER INBOX] block. Each block tells you how to reply (use send_message with the sender's name). Treat each as a coworker tapping you on the shoulder — finish your current step, then respond.

On startup, call set_summary with a 1-2 sentence description of your work.

Tools:
- list_peers(scope, peer_type?)
- send_message(to_id, message)       // to_id accepts name or UUID
- set_summary(summary)
- check_messages
- rename_peer(new_name)              // renames YOU only; 1-32 chars, [a-zA-Z0-9_-]`
  }
);

const TOOLS = [
  { name: "list_peers", description: "List other AI agent peers on this machine.",
    inputSchema: { type: "object" as const, properties: {
      scope: { type: "string" as const, enum: ["machine", "directory", "repo"] },
      peer_type: { type: "string" as const, enum: ["claude", "codex"] },
    }, required: ["scope"] } },
  { name: "send_message", description: "Send a message to a peer (to_id accepts UUID or name).",
    inputSchema: { type: "object" as const, properties: {
      to_id: { type: "string" as const }, message: { type: "string" as const },
    }, required: ["to_id", "message"] } },
  { name: "set_summary", description: "Set 1-2 sentence summary of current work.",
    inputSchema: { type: "object" as const, properties: { summary: { type: "string" as const } }, required: ["summary"] } },
  { name: "check_messages", description: "Explicitly check inbox (the same piggyback fires on any tool call).",
    inputSchema: { type: "object" as const, properties: {} } },
  { name: "rename_peer", description: "Rename yourself; 1-32 chars, [a-zA-Z0-9_-].",
    inputSchema: { type: "object" as const, properties: { new_name: { type: "string" as const } }, required: ["new_name"] } },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Module-level ack-on-next-call state (spec §5.5).
// Each tool call flushes acks from the PREVIOUS call (proof the previous response was
// delivered to Codex, because Codex is calling us again), then polls and stores new tokens
// for the NEXT call. See Codex adversarial review round-2 for why ack-during-handler-return
// is insufficient.
const pendingAcks: string[] = [];
const seen = new Set<number>();

async function withPiggyback(
  handler: () => Promise<{ text: string; isError?: boolean }>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (!myId) return { content: [{ type: "text", text: "Not registered with broker yet" }], isError: true };

  // 1. Flush previous-call acks — only now do we know the previous response reached Codex.
  if (pendingAcks.length > 0) {
    const toFlush = pendingAcks.splice(0, pendingAcks.length);
    try { await client.ackMessages({ id: myId, lease_tokens: toFlush }); }
    catch (e) { log(`pending ack flush failed (lease will expire): ${e instanceof Error ? e.message : String(e)}`); }
  }

  // 2. Poll for new messages.
  let leased: LeasedMessage[] = [];
  try { leased = await client.pollMessages(myId); } catch (e) { log(`poll failed: ${e instanceof Error ? e.message : String(e)}`); }

  // 3. Partition polled messages into fresh vs re-delivery.
  const fresh: LeasedMessage[] = [];
  for (const m of leased) {
    if (seen.has(m.id)) {
      // Re-delivery after lost ack. Queue its lease_token for next-call ack so the broker
      // can finally close the stuck lease. Do NOT re-inject.
      pendingAcks.push(m.lease_token);
    } else {
      fresh.push(m);
      seen.add(m.id);
      pendingAcks.push(m.lease_token);
    }
  }

  // 4. Run the tool's own logic.
  let toolText = "";
  let toolError: boolean | undefined;
  try {
    const r = await handler();
    toolText = r.text;
    toolError = r.isError;
  } catch (e) {
    toolText = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
    toolError = true;
  }

  // 5. Return response with inbox prepended. Ack of these leases will happen on the NEXT call.
  const inbox = formatInboxBlock(fresh);
  const finalText = inbox + toolText;
  return { content: [{ type: "text", text: finalText }], isError: toolError };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  return withPiggyback(async () => {
    switch (name) {
      case "list_peers": {
        const { scope, peer_type } = args as { scope: "machine" | "directory" | "repo"; peer_type?: "claude" | "codex" };
        const peers = await client.listPeers({ scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId!, peer_type });
        if (peers.length === 0) return { text: `No other peers found (scope: ${scope}).` };
        const lines = peers.map(p => [
          `Peer ${p.name} (${p.peer_type})`,
          `  ID: ${p.id}`, `  CWD: ${p.cwd}`,
          p.tty ? `  TTY: ${p.tty}` : null,
          p.summary ? `  Summary: ${p.summary}` : null,
          `  Last seen: ${p.last_seen}`,
        ].filter(Boolean).join("\n"));
        return { text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` };
      }
      case "send_message": {
        const { to_id, message } = args as { to_id: string; message: string };
        const res = await client.sendMessage({ from_id: myId!, to_id_or_name: to_id, text: message });
        if (!res.ok) return { text: `Send failed: ${res.error}`, isError: true };
        return { text: `Message sent (id=${res.message_id}).` };
      }
      case "set_summary": {
        const { summary } = args as { summary: string };
        await client.setSummary({ id: myId!, summary });
        return { text: `Summary set: "${summary}"` };
      }
      case "check_messages": {
        // Piggyback already polled + included inbox; this tool is a no-op user-triggered prompt.
        return { text: `Checked inbox.` };
      }
      case "rename_peer": {
        const { new_name } = args as { new_name: string };
        if (!isValidName(new_name)) return { text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.`, isError: true };
        const res = await client.renamePeer({ id: myId!, new_name });
        if (!res.ok) return { text: `Rename failed: ${res.error}`, isError: true };
        myName = res.name ?? new_name;
        setTabTitle(`peer:${myName}`);
        return { text: `Renamed to ${myName}` };
      }
      default: return { text: `Unknown tool: ${name}`, isError: true };
    }
  });
});

async function main() {
  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(client, brokerScriptUrl);

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const [branch, recent_files] = await Promise.all([getGitBranch(myCwd), getRecentFiles(myCwd)]);
      initialSummary = await generateSummary({ cwd: myCwd, git_root: myGitRoot, git_branch: branch, recent_files });
    } catch { /* non-critical */ }
  })();
  await Promise.race([summaryPromise, new Promise(r => setTimeout(r, 3000))]);

  const reg = await client.register({
    peer_type: "codex",
    name: process.env.PEER_NAME,
    pid: process.pid, cwd: myCwd, git_root: myGitRoot, tty, summary: initialSummary,
  });
  myId = reg.id;
  myName = reg.name;
  setTabTitle(`peer:${myName}`);
  log(`Registered as ${myName} (id=${myId})`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) { try { await client.setSummary({ id: myId, summary: initialSummary }); } catch { /* non-critical */ } }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const hb = setInterval(async () => {
    if (myId) { try { await client.heartbeat(myId); } catch { /* non-critical */ } }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(hb);
    // INTENTIONALLY do NOT flush pendingAcks on shutdown (Codex review round-3 fix).
    // Those tokens correspond to the MOST RECENT response, whose delivery we cannot
    // confirm. Flushing them here would silently ack messages that may never have
    // reached Codex. Instead let leases expire — when the next Codex session comes
    // up with a fresh seen-set, the broker will re-lease and re-inject.
    if (myId) { try { await client.unregister(myId); } catch { /* best effort */ } }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(e => { log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add codex-server.ts
git commit -m "feat(codex-server): piggyback + ack-on-next-call + seen-set dedupe (no shutdown flush)"
```

---

## Task 20: `cli.ts` — status / peers / send / rename / kill-broker

**Files:**
- Create: `cli.ts`

- [ ] **Step 1: Write `cli.ts`**

```ts
#!/usr/bin/env bun
// cli.ts
// Inspection + admin CLI for agent-peers-mcp. Talks to broker on :7900.

import { createClient } from "./shared/broker-client.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const client = createClient(BROKER_URL);

async function cmdStatus() {
  const alive = await client.isAlive();
  if (!alive) { console.log(`broker: not running on ${BROKER_URL}`); process.exit(1); }
  console.log(`broker: running on ${BROKER_URL}`);
  await cmdPeers();
}

async function cmdPeers() {
  const peers = await client.listPeers({ scope: "machine", cwd: process.cwd(), git_root: null });
  if (peers.length === 0) { console.log("(no peers registered)"); return; }
  for (const p of peers) {
    console.log(`${p.name}  (${p.peer_type})  id=${p.id}`);
    console.log(`  cwd=${p.cwd}${p.tty ? `  tty=${p.tty}` : ""}`);
    if (p.summary) console.log(`  summary: ${p.summary}`);
    console.log(`  last_seen=${p.last_seen}`);
  }
}

async function cmdSend(targetNameOrId: string, message: string) {
  // CLI sender does not have its own peer id, so we use the broker-ish sentinel "cli"
  // which is a recognizable non-UUID string that will fail liveness but still be accepted
  // as a sender attribution string. The broker stores from_id verbatim; recipients see it
  // as "cli" in from_name (no corresponding peer row → "(gone)" in enriched fields).
  //
  // Implementation detail: the broker's send liveness check is ONLY applied to the target,
  // so an un-registered sender is acceptable.
  const res = await client.sendMessage({ from_id: "cli", to_id_or_name: targetNameOrId, text: message });
  if (!res.ok) { console.error(`send failed: ${res.error}`); process.exit(1); }
  console.log(`sent (id=${res.message_id})`);
}

async function cmdRename(target: string, newName: string) {
  const peers = await client.listPeers({ scope: "machine", cwd: process.cwd(), git_root: null });
  const found = peers.find(p => p.id === target || p.name === target);
  if (!found) { console.error(`no peer matching '${target}'`); process.exit(1); }
  const res = await client.renamePeer({ id: found.id, new_name: newName });
  if (!res.ok) { console.error(`rename failed: ${res.error}`); process.exit(1); }
  console.log(`renamed ${found.name} -> ${res.name}`);
}

async function cmdOrphans() {
  // Orphans need DB access, which the CLI doesn't have natively — hit a small broker
  // endpoint. For Phase 1 we expose this by opening the SQLite file directly in read-only
  // mode. This works because SQLite WAL allows concurrent readers.
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  type Row = { id: number; from_id: string; to_id: string; text: string; sent_at: string };
  const rows = db.query<Row, []>(
    `SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at
     FROM messages m
     LEFT JOIN peers p ON p.id = m.to_id
     WHERE p.id IS NULL AND m.acked = 0
     ORDER BY m.id ASC`
  ).all();
  db.close();
  if (rows.length === 0) { console.log("(no orphaned messages)"); return; }
  for (const r of rows) {
    const preview = r.text.length > 80 ? r.text.slice(0, 77) + "..." : r.text;
    console.log(`#${r.id}  from=${r.from_id}  to=${r.to_id}  sent=${r.sent_at}`);
    console.log(`  ${preview}`);
  }
}

async function cmdKillBroker() {
  // No admin endpoint — use lsof + kill as a pragmatic helper.
  const proc = Bun.spawn(["lsof", "-t", "-i", `:${BROKER_PORT}`], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) { console.log("broker not running"); return; }
  for (const pid of out.split("\n")) {
    try { process.kill(Number(pid), "SIGTERM"); console.log(`killed pid=${pid}`); }
    catch (e) { console.error(`kill ${pid} failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

const [_bun, _script, sub, ...rest] = process.argv;
switch (sub) {
  case "status":      await cmdStatus(); break;
  case "peers":       await cmdPeers(); break;
  case "send":        if (rest.length < 2) { console.error("usage: cli.ts send <name-or-id> <message>"); process.exit(2); } await cmdSend(rest[0]!, rest.slice(1).join(" ")); break;
  case "rename":      if (rest.length !== 2) { console.error("usage: cli.ts rename <name-or-id> <new-name>"); process.exit(2); } await cmdRename(rest[0]!, rest[1]!); break;
  case "orphaned-messages": await cmdOrphans(); break;
  case "kill-broker": await cmdKillBroker(); break;
  default:
    console.log(`usage:
  bun cli.ts status
  bun cli.ts peers
  bun cli.ts send <name-or-id> <message>
  bun cli.ts rename <name-or-id> <new-name>
  bun cli.ts orphaned-messages
  bun cli.ts kill-broker`);
    process.exit(sub ? 2 : 0);
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Smoke-test the CLI**

```bash
# in one terminal
bun broker.ts
# in another
bun cli.ts status
bun cli.ts peers
bun cli.ts kill-broker
```
Expected: status shows broker running with no peers; kill-broker terminates it.

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat(cli): status/peers/send/rename/kill-broker"
```

---

## Task 21: README with copy-paste install + usage

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# agent-peers-mcp

Peer discovery + messaging MCP for Claude Code **and** Codex CLI sessions running on the same machine. Any agent can discover any other (Claude↔Claude, Claude↔Codex, Codex↔Codex) and send messages that arrive instantly for Claude (channel push) or on the next tool call for Codex (piggyback).

Runs **fully isolated** from the upstream `claude-peers-mcp`: different port (7900 vs 7899), different DB (`~/.agent-peers.db`), different MCP registration name (`agent-peers`). You can keep both installed side by side.

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
agentpeers                       # launch Claude with the peer network
PEER_NAME=frontend-tab agentpeers  # launch with an explicit name
codex                            # Codex picks up the MCP via config.toml
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

Both can run simultaneously. They do not talk to each other.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with install + usage"
```

---

## Task 22: Type-check everything + commit lockfile

- [ ] **Step 1: Full typecheck**

```bash
bunx tsc --noEmit
```
Expected: exit 0, no errors across all files.

- [ ] **Step 2: Run all unit tests**

```bash
bun test
```
Expected: all tests pass.

- [ ] **Step 3: Commit lockfile if it drifted**

```bash
git add bun.lock
git commit -m "chore: lockfile"  # skip if nothing to commit
```

---

## Task 23: End-to-end smoke test — Claude ↔ Claude

This is a manual test. Do not mark the task complete unless every step passes.

- [ ] **Step 1: Register the MCP globally**

```bash
claude mcp add --scope user --transport stdio agent-peers -- \
  bun "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/claude-server.ts"
```

- [ ] **Step 2: Add alias to `~/.zshrc` and reload**

```bash
printf '\nalias agentpeers='"'"'claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'"'"'\n' >> ~/.zshrc
source ~/.zshrc
```

- [ ] **Step 3: Terminal 1 — `agentpeers` with explicit name**

```bash
PEER_NAME=ct1 agentpeers
```
Expected: terminal tab renames to `peer:ct1`, Claude starts.

- [ ] **Step 4: Terminal 2 — `agentpeers` with different name**

```bash
PEER_NAME=ct2 agentpeers
```
Expected: terminal tab renames to `peer:ct2`.

- [ ] **Step 5: In terminal 1 (Claude), ask:**

> "List all peers on this machine"

Expected: sees `ct2 (claude)` with ID and cwd.

- [ ] **Step 6: In terminal 1, ask:**

> "Send a message to peer ct2: 'ping from ct1'"

Expected: Claude confirms sent with message_id.

- [ ] **Step 7: In terminal 2, observe:**

Claude should receive a `<channel source="agent-peers" ...>` message mid-task, containing `ping from ct1`.

- [ ] **Step 8: Kill both sessions, kill broker**

```bash
bun "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/cli.ts" kill-broker
```

---

## Task 24: End-to-end smoke test — Claude ↔ Codex and Codex ↔ Codex

- [ ] **Step 1: Ensure the Codex MCP entry exists**

Verify `~/.codex/config.toml` contains:
```toml
[mcp_servers.agent-peers]
command = "bun"
args = ["/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/codex-server.ts"]
```

- [ ] **Step 2: Terminal 1 — `PEER_NAME=cl1 agentpeers`**

Expected: Claude starts, tab renames.

- [ ] **Step 3: Terminal 2 — `PEER_NAME=cx1 codex`**

Expected: Codex starts, tab renames.

- [ ] **Step 4: In Codex (terminal 2), ask:**

> "List all peers"

Expected: sees `cl1 (claude)`. The tool response also includes an empty inbox (no messages).

- [ ] **Step 5: In Claude (terminal 1), send to Codex:**

> "Send a message to peer cx1: 'hello from claude'"

- [ ] **Step 6: In Codex (terminal 2), ask Codex to do anything that calls any agent-peers tool:**

> "Check your agent-peers inbox"

Expected: response contains `[PEER INBOX] 1 new peer message(s)` with the text `hello from claude` and `from: cl1 (claude)`.

- [ ] **Step 7: In Codex, reply:**

> "Send a message to peer cl1: 'hi back'"

- [ ] **Step 8: In Claude (terminal 1), the channel notification should arrive**

Expected: Claude shows the `<channel source="agent-peers">` block with `hi back` from `cx1 (codex)`.

- [ ] **Step 9: Terminal 3 — launch a second Codex**

```bash
PEER_NAME=cx2 codex
```

- [ ] **Step 10: In `cx1`, send to `cx2`**

> "Send a message to peer cx2: 'codex to codex'"

- [ ] **Step 11: In `cx2`, call list_peers**

Expected: `[PEER INBOX]` block with `codex to codex` from `cx1`.

- [ ] **Step 12: Kill all sessions, kill broker**

```bash
bun "/Users/siewbrayden/Desktop/Brayden's Projects/agent-peers-mcp/cli.ts" kill-broker
```

---

## Task 25: Regression smoke tests for round-3/4 delivery guarantees

Manual validation for the invariants Codex asked us to protect. Do not mark this task complete until every step passes.

- [ ] **Step 1: Shutdown does NOT flush pendingAcks (round-3 critical)**

```bash
# Start Codex session A (sender) and Codex session B (receiver)
PEER_NAME=sender codex &
PEER_NAME=receiver codex &

# In sender: send a message to receiver
# Then IMMEDIATELY send SIGTERM to receiver BEFORE receiver acknowledges by calling another tool
kill -TERM <receiver-pid>

# Restart receiver as a fresh process
PEER_NAME=receiver codex
# In receiver, call any tool (e.g., list_peers)
# Expected: [PEER INBOX] block contains the message — it was NOT silently acked on shutdown.
```

- [ ] **Step 2: Codex inbox surfaces on ANY tool call, not just check_messages (round-4 medium)**

Start a Codex session. Have another session send a message. In Codex:
- Call `list_peers` (not `check_messages`)
- Expected: `[PEER INBOX]` block is prepended to the `list_peers` response.

- [ ] **Step 3: Residual narrow-window documentation is accurate (round-4 residual limit)**

Read spec §5.5 "Residual limitations" out loud. Confirm the known-limitation scenarios match what's actually implemented. File a Phase 2 ticket for explicit client receipts if you want stricter delivery.

---

## Task 26: Final commit + tag

- [ ] **Step 1: Ensure tree is clean**

```bash
git status
```
Expected: nothing to commit.

- [ ] **Step 2: Tag v0.1.0**

```bash
git tag -a v0.1.0 -m "agent-peers-mcp Phase 1 MVP"
```

- [ ] **Step 3: Log summary**

```bash
git log --oneline
```
Confirm the commit history tells a clean linear story of the build.

---

## Implementation summary

- **Phase 1 correctness primitives:** lease+ack delivery, timer-driven GC, liveness checks on send, self-rename only, piggyback delivery for Codex with inline reply hints.
- **Phase 1 ergonomics:** auto-generated friendly names, `PEER_NAME` override, terminal tab title, `list_peers` filterable by `peer_type`, `send_message` accepts name-or-id.
- **Isolation:** different port, DB, MCP registration name, alias from upstream `claude-peers-mcp`.
- **Testing:** unit coverage of name validation, broker CRUD, list filters, send liveness, poll leasing, ack, rename, GC, piggyback block formatting, end-to-end broker HTTP client. Manual smoke coverage of all four delivery modes.
