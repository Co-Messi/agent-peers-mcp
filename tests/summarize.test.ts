import { afterEach, expect, test } from "bun:test";
import { generateSummary } from "../shared/summarize.ts";

const originalKey = process.env.OPENAI_API_KEY;
const originalOptIn = process.env.AGENT_PEERS_AUTO_SUMMARY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalOptIn === undefined) delete process.env.AGENT_PEERS_AUTO_SUMMARY;
  else process.env.AGENT_PEERS_AUTO_SUMMARY = originalOptIn;
});

const input = {
  cwd: "/Users/alice/Secret Client/project",
  git_root: "/Users/alice/Secret Client/project",
  git_branch: "feature/private",
  recent_files: ["customers/acme-passwords.ts", "src/index.ts"],
};

test("generateSummary requires explicit opt-in even when an API key exists", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.AGENT_PEERS_AUTO_SUMMARY;
  let called = false;
  const result = await generateSummary(input, async () => {
    called = true;
    return Response.json({ choices: [] });
  });
  expect(result).toBe("");
  expect(called).toBe(false);
});

test("generateSummary redacts absolute paths and frames repository metadata as data", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.AGENT_PEERS_AUTO_SUMMARY = "1";
  let sentBody = "";
  const result = await generateSummary(input, async (_url, init) => {
    sentBody = String(init?.body ?? "");
    return Response.json({ choices: [{ message: { content: "Working on the entry point." } }] });
  });
  expect(result).toBe("Working on the entry point.");
  expect(sentBody).not.toContain("/Users/alice");
  expect(sentBody).not.toContain("Secret Client");
  expect(sentBody).toContain("UNTRUSTED_REPOSITORY_METADATA");
});
