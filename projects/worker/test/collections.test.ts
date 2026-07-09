import { it, expect } from "vitest";
import {
  newCollectionId, combinedPrompt, validateCollectionFields, collectionView,
  MAX_COLLECTIONS_PER_USER, MAX_COLLECTION_NAME_LEN, MAX_THEME_PROMPT_LEN,
} from "../src/collections";

it("newCollectionId: col_ + 20 base32 chars, unique across calls", () => {
  const a = newCollectionId();
  const b = newCollectionId();
  expect(a).toMatch(/^col_[a-z2-7]{20}$/);
  expect(a).not.toBe(b);
});

it("combinedPrompt appends theme with a comma; blank theme is identity", () => {
  expect(combinedPrompt("a cat", "watercolor style")).toBe("a cat, watercolor style");
  expect(combinedPrompt("a cat", "")).toBe("a cat");
  expect(combinedPrompt("a cat", "   ")).toBe("a cat");
});

it("limits are pinned", () => {
  expect(MAX_COLLECTIONS_PER_USER).toBe(20);
  expect(MAX_COLLECTION_NAME_LEN).toBe(80);
  expect(MAX_THEME_PROMPT_LEN).toBe(500);
});

it("validateCollectionFields (create): requires non-empty name, bounds both fields", () => {
  expect(validateCollectionFields({ name: "Retro", theme_prompt: "retro poster" }, false))
    .toEqual({ name: "Retro", themePrompt: "retro poster" });
  expect(validateCollectionFields({ name: "Retro" }, false)).toEqual({ name: "Retro", themePrompt: "" });
  expect("error" in (validateCollectionFields({}, false) as any)).toBe(true);
  expect("error" in (validateCollectionFields({ name: "  " }, false) as any)).toBe(true);
  expect("error" in (validateCollectionFields({ name: "x".repeat(81) }, false) as any)).toBe(true);
  expect("error" in (validateCollectionFields({ name: "ok", theme_prompt: "x".repeat(501) }, false) as any)).toBe(true);
  expect("error" in (validateCollectionFields({ name: "ok", theme_prompt: 7 }, false) as any)).toBe(true);
});

it("validateCollectionFields (partial): only provided fields, at least one required", () => {
  expect(validateCollectionFields({ theme_prompt: "new" }, true)).toEqual({ themePrompt: "new" });
  expect(validateCollectionFields({ name: "New name" }, true)).toEqual({ name: "New name" });
  expect("error" in (validateCollectionFields({}, true) as any)).toBe(true);
});

it("collectionView exposes the public shape (no owner id)", () => {
  const v: any = collectionView({
    id: "col_abc", owner_user_id: "usr_1", name: "n", theme_prompt: "t",
    created_at: "2026-07-09", updated_at: "2026-07-09", image_count: 2, total_serves: 5,
  } as any);
  expect(v).toEqual({
    id: "col_abc", name: "n", theme_prompt: "t",
    created_at: "2026-07-09", updated_at: "2026-07-09", image_count: 2, total_serves: 5,
  });
  // owner id never leaves the server
  expect("owner_user_id" in v).toBe(false);
});
