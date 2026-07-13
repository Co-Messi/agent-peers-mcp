import { expect, test } from "bun:test";
import { parsePort } from "../shared/config.ts";

test("parsePort accepts valid integer TCP ports", () => {
  expect(parsePort("7900", 8000)).toBe(7900);
});

test("parsePort rejects partial, privileged, and out-of-range values", () => {
  expect(() => parsePort("7900oops", 8000)).toThrow(/port/i);
  expect(() => parsePort("80", 8000)).toThrow(/port/i);
  expect(() => parsePort("70000", 8000)).toThrow(/port/i);
});
