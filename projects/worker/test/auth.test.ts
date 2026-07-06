import { describe, it, expect } from "vitest";
import { sha256Hex, constantTimeEqual } from "../src/auth";

it("sha256Hex is stable hex", async () => {
  const h = await sha256Hex("sc-secret");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(await sha256Hex("sc-secret")).toBe(h);
});

it("constantTimeEqual: true for equal strings, false for differing or different-length", () => {
  expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  expect(constantTimeEqual("", "")).toBe(true);
  expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
  expect(constantTimeEqual("abcd", "abc")).toBe(false);
});
