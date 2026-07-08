import { it, expect } from "vitest";
import { deniedTerm } from "../src/denylist";

it("matches a denied term case-insensitively", () => {
  expect(deniedTerm("A cute Pikachu on a beach")).toBe("pikachu");
});

it("is word-bounded: apple-like substrings do not trip", () => {
  // "mario" must not match inside "marionette"
  expect(deniedTerm("a marionette puppet on strings")).toBeNull();
});

it("matches multi-word and hyphenated terms", () => {
  expect(deniedTerm("spider-man swinging through the city")).toBe("spider-man");
  expect(deniedTerm("STAR WARS style spaceship")).toBe("star wars");
});

it("returns null for clean prompts", () => {
  expect(deniedTerm("a red fox in the snow")).toBeNull();
});
