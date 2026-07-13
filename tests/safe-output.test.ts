import { expect, test } from "bun:test";
import { sanitizeTerminalText } from "../shared/safe-output.ts";

test("sanitizeTerminalText removes ANSI and line-control injection", () => {
  expect(sanitizeTerminalText("ok\n\x1b[2Jspoof\x07")).toBe("ok  [2Jspoof ");
});

test("sanitizeTerminalText bounds output", () => {
  expect(sanitizeTerminalText("x".repeat(50), 10)).toBe("x".repeat(10));
});
