import { expect, test } from "bun:test";
import { createLogger } from "../shared/logger.ts";

test("structured logger redacts secrets, message bodies, and local paths", () => {
  const lines: string[] = [];
  const logger = createLogger("test", (line) => lines.push(line));
  logger.info("request", {
    request_id: "req-1",
    session_token: "super-secret",
    message: "private body",
    cwd: "/Users/alice/private",
    count: 3,
  });
  const event = JSON.parse(lines[0]!);
  expect(event).toMatchObject({ component: "test", level: "info", event: "request", request_id: "req-1", count: 3 });
  expect(JSON.stringify(event)).not.toContain("super-secret");
  expect(JSON.stringify(event)).not.toContain("private body");
  expect(JSON.stringify(event)).not.toContain("/Users/alice");
});
