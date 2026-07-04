import { it, expect } from "vitest";
import { numEnv } from "../src/config";

it("numEnv: default for unset/blank/unparseable, parses valid values including 0", () => {
  expect(numEnv(undefined, 5)).toBe(5);
  expect(numEnv("", 5)).toBe(5);
  expect(numEnv("   ", 5)).toBe(5);
  expect(numEnv("abc", 5)).toBe(5);   // was Number("abc") = NaN, used unvalidated
  expect(numEnv("0", 5)).toBe(0);     // a genuine 0 is honored, not dropped
  expect(numEnv("0.3", 5)).toBe(0.3);
  expect(numEnv("-1", 5)).toBe(-1);
});
