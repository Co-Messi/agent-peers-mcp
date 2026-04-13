import { test, expect } from "bun:test";
import { generateName, isValidName, NAME_REGEX } from "../shared/names.ts";

test("generateName returns adjective-noun", () => {
  const name = generateName();
  expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  expect(name.length).toBeGreaterThanOrEqual(5);
  expect(name.length).toBeLessThanOrEqual(32);
});

test("generateName varies across calls", () => {
  const s = new Set<string>();
  for (let i = 0; i < 20; i++) s.add(generateName());
  expect(s.size).toBeGreaterThan(1);
});

test("isValidName rejects empty, too long, bad chars, and UUID-shaped", () => {
  expect(isValidName("")).toBe(false);
  expect(isValidName("a".repeat(33))).toBe(false);
  expect(isValidName("has space")).toBe(false);
  expect(isValidName("has/slash")).toBe(false);
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
