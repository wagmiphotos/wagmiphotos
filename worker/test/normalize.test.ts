import { describe, it, expect } from "vitest";
import { normalizePrompt } from "../src/normalize";

describe("normalizePrompt", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizePrompt("  A  Red   Fox ")).toBe("a red fox");
  });
});
