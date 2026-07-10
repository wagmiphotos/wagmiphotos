import type { CollectionRow, CollectionSummary } from "./types";

export const MAX_COLLECTIONS_PER_USER = 20;
export const MAX_COLLECTION_NAME_LEN = 80;
export const MAX_THEME_PROMPT_LEN = 500;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Unguessable id; doubles as the share capability (anyone with it may scope searches). */
export function newCollectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "col_";
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}

/** The prompt actually generated/embedded for a collection: theme appended,
 *  blank theme is the identity (spec: embedding honesty rule). */
export function combinedPrompt(prompt: string, theme: string): string {
  const t = theme.trim();
  return t ? `${prompt}, ${t}` : prompt;
}

/** Validates create (partial=false: name required, theme defaults "") or
 *  patch (partial=true: at least one field) bodies. */
export function validateCollectionFields(
  body: any, partial: boolean
): { name?: string; themePrompt?: string } | { error: string } {
  const out: { name?: string; themePrompt?: string } = {};
  if (body?.name != null || !partial) {
    if (typeof body?.name !== "string" || body.name.trim() === "") return { error: "name must be a non-empty string" };
    if (body.name.length > MAX_COLLECTION_NAME_LEN) return { error: `name must be at most ${MAX_COLLECTION_NAME_LEN} characters` };
    out.name = body.name.trim();
  }
  if (body?.theme_prompt != null) {
    if (typeof body.theme_prompt !== "string") return { error: "theme_prompt must be a string" };
    if (body.theme_prompt.length > MAX_THEME_PROMPT_LEN) return { error: `theme_prompt must be at most ${MAX_THEME_PROMPT_LEN} characters` };
    out.themePrompt = body.theme_prompt.trim();
  } else if (!partial) {
    out.themePrompt = "";
  }
  if (partial && out.name == null && out.themePrompt == null) return { error: "provide name and/or theme_prompt" };
  return out;
}

/** Public JSON shape: owner_user_id stays server-side. */
export function collectionView(c: CollectionRow | CollectionSummary) {
  return {
    id: c.id, name: c.name, theme_prompt: c.theme_prompt,
    created_at: c.created_at, updated_at: c.updated_at,
    ...("image_count" in c ? { image_count: c.image_count, total_serves: c.total_serves, search_count: c.search_count } : {}),
  };
}

/** Lifetime generations required to create your nth collection (1-based):
 *  the first needs only an enabled BYOK key, the nth needs 10^(n-1)
 *  (2nd -> 10, 3rd -> 100, ...). Spec: 2026-07-09-collection-slots-design.md */
export function requiredGenerationsFor(nth: number): number {
  return nth <= 1 ? 0 : 10 ** (nth - 1);
}
