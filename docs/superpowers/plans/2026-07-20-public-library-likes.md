# Public Library + Image Likes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open `/v1/library` to anonymous browsing (per-IP rate-limited) and add logged-in image likes, with a likes-ranked default library view and a "Most liked / Best match" sort toggle.

**Architecture:** A new `likes` table plus a trigger-maintained `assets.like_count` counter (the app only ever writes the `likes` table; triggers keep the count drift-free). The Worker's `handleLibrarySearch` gains a `sort` param and a `liked` per-user flag; two new like/unlike routes mutate likes. The login gate on library read is replaced by two dedicated rate-limiter namespaces (anon-by-IP, user-by-id). The vanilla-JS SPA in `public/index.html` gets a heart control and a sort toggle.

**Tech Stack:** Cloudflare Workers (TypeScript), D1 (SQLite), Vitest with a real-schema `node:sqlite` harness (`test/real-d1.ts`), CF `ratelimit` unsafe bindings, hand-written SPA in `public/index.html`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-public-library-likes-design.md`. Every task implements part of it.
- Branch: `feat/public-library-likes` (already exists, holds the spec). Do all work there.
- Working dir for all commands: `projects/worker`.
- Test runner: `npx vitest run <file>` (single file) or `npx vitest run <file> -t "<name>"` (single test). Full suite: `npm test`.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Reads MUST go through `live_assets` (the `dead_at IS NULL` view), never `assets` directly — existing invariant.
- Likes are NOT paid-gated: any authenticated principal (session cookie or bearer key) may like. Paid surfaces (`/v1/images/generations`, `/v1/keys/generate`) are untouched.
- No changes to the demand/generation loop, backfill, or BYOK. Likes are display-only signal.
- Migrations are immutable and applied in filename order; the new one is `0020_likes.sql`. The latest existing migration is `0019_plan_cancel_at_period_end.sql`.

---

## File Structure

- **Create** `migrations/0020_likes.sql` — likes table, `like_count` column, two triggers, browse index.
- **Modify** `src/types.ts` — `AssetRow.like_count`; new `AssetStore` methods; `Env` + `Services` gain the two search limiters.
- **Modify** `src/d1.ts` — `ASSET_COLS` gains `like_count`; implement `likeAsset` / `unlikeAsset` / `likedByUser` / `browseByLikes`.
- **Modify** `src/library.ts` — `publicAsset` emits `like_count` (+ optional `liked`); `handleLibrarySearch` gains `sort` + `userId`; new `handleLikeAsset` / `handleUnlikeAsset`.
- **Modify** `src/index.ts` — build the two limiters; open library GET + download to anon behind a shared rate-limit helper; wire like/unlike routes; pass `userId` into search.
- **Modify** `wrangler.toml` — two `ratelimit` bindings (namespace 1003, 1004).
- **Modify** `public/index.html` — sort toggle, heart control on cards + modal, `toggleLike`, `sort` param in `loadLibrary`.
- **Modify** `test/fakes.ts` — likes fakes + `like_count` on returned rows + the two search limiters.
- **Modify** `test/d1-real-schema.test.ts`, `test/library.test.ts`, `test/router.test.ts` — new tests + update the two obsolete gate tests.

---

## Task 1: Migration 0020 — likes table, counter, triggers

**Files:**
- Create: `migrations/0020_likes.sql`
- Test: `test/d1-real-schema.test.ts` (append)

**Interfaces:**
- Produces: schema objects `likes(user_id, asset_id, created_at)`, `assets.like_count`, triggers `likes_after_insert` / `likes_after_delete`, index `idx_assets_like_browse`. Validated only through raw SQL in this task; the typed store wraps them in Task 2.

- [ ] **Step 1: Write the failing test** — append to `test/d1-real-schema.test.ts`:

```ts
it("0020: like_count is trigger-maintained and INSERT OR IGNORE is idempotent", async () => {
  const db = realDb();
  seedUser(db, "usr_1");
  seedUser(db, "usr_2");
  const { assets } = makeD1Stores(db);
  await assets.insertGenerated({ id: "lk1", prompt: "p", sourceUrl: "https://x/1.webp", mime: "image/webp",
    width: 1, height: 1, modelUsed: "m", provider: "openai", priceUsd: 0.01, createdBy: "usr_1", collectionId: null });

  const count = () => db._raw.prepare("SELECT like_count FROM assets WHERE id='lk1'").get().like_count;
  expect(count()).toBe(0);
  db._raw.exec("INSERT OR IGNORE INTO likes (user_id, asset_id) VALUES ('usr_1','lk1')");
  expect(count()).toBe(1);
  db._raw.exec("INSERT OR IGNORE INTO likes (user_id, asset_id) VALUES ('usr_1','lk1')"); // dup: no trigger
  expect(count()).toBe(1);
  db._raw.exec("INSERT OR IGNORE INTO likes (user_id, asset_id) VALUES ('usr_2','lk1')");
  expect(count()).toBe(2);
  db._raw.exec("DELETE FROM likes WHERE user_id='usr_1' AND asset_id='lk1'");
  expect(count()).toBe(1);
  db._raw.exec("DELETE FROM likes WHERE user_id='usr_1' AND asset_id='lk1'"); // absent: no trigger
  expect(count()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/d1-real-schema.test.ts -t "0020: like_count"`
Expected: FAIL — `no such table: likes` (or `no such column: like_count`).

- [ ] **Step 3: Create the migration** — `migrations/0020_likes.sql`:

```sql
-- Image likes (Task: public library + likes, 2026-07-20).
-- like_count on assets is maintained by triggers so it can never drift from the
-- likes table: the app only ever writes `likes` (INSERT OR IGNORE / DELETE).
CREATE TABLE likes (
  user_id    TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, asset_id)
);
CREATE INDEX idx_likes_asset ON likes(asset_id);

ALTER TABLE assets ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER likes_after_insert AFTER INSERT ON likes
BEGIN
  UPDATE assets SET like_count = like_count + 1 WHERE id = NEW.asset_id;
END;
CREATE TRIGGER likes_after_delete AFTER DELETE ON likes
BEGIN
  UPDATE assets SET like_count = like_count - 1 WHERE id = OLD.asset_id;
END;

-- Serves the default browse: WHERE collection_id IS NULL ORDER BY like_count DESC, locally_cached DESC, id.
CREATE INDEX idx_assets_like_browse
  ON assets(collection_id, like_count DESC, locally_cached DESC, id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/d1-real-schema.test.ts -t "0020: like_count"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0020_likes.sql test/d1-real-schema.test.ts
git commit -m "feat(db): migration 0020 — likes table + trigger-maintained like_count"
```

---

## Task 2: D1 store — like/unlike/likedByUser/browseByLikes + like_count in reads

**Files:**
- Modify: `src/types.ts` (add `like_count` to `AssetRow`; add four `AssetStore` methods)
- Modify: `src/d1.ts` (`ASSET_COLS`; four method impls)
- Test: `test/d1-real-schema.test.ts` (append)

**Interfaces:**
- Consumes: schema from Task 1.
- Produces, on `AssetStore`:
  - `likeAsset(userId: string, id: string): Promise<number>` — idempotent like; returns the post-state `like_count`.
  - `unlikeAsset(userId: string, id: string): Promise<number>` — idempotent unlike; returns the post-state `like_count`.
  - `likedByUser(userId: string, ids: string[]): Promise<string[]>` — subset of `ids` the user has liked.
  - `browseByLikes(i: { limit: number; offset: number; collectionId?: string }): Promise<LibraryAssetRow[]>` — likes-ranked page; unscoped view excludes collection assets.
  - `AssetRow.like_count: number` now present on every asset row (so `LibraryAssetRow` / `CollectionImageRow` inherit it).

- [ ] **Step 1: Write the failing test** — append to `test/d1-real-schema.test.ts`:

```ts
it("0020 store: like/unlike round-trip, likedByUser, and browseByLikes ordering", async () => {
  const db = realDb();
  seedUser(db, "usr_1");
  const { assets } = makeD1Stores(db);
  const mk = (id: string, cached = 0) => assets.insertGenerated({ id, prompt: id, sourceUrl: `https://x/${id}.webp`,
    mime: "image/webp", width: 1, height: 1, modelUsed: "m", provider: "openai", priceUsd: 0.01, createdBy: "usr_1", collectionId: null });
  await mk("a"); await mk("b"); await mk("c", 1);

  expect(await assets.likeAsset("usr_1", "b")).toBe(1);
  expect(await assets.likeAsset("usr_1", "b")).toBe(1);            // idempotent
  expect(await assets.unlikeAsset("usr_1", "b")).toBe(0);
  expect(await assets.unlikeAsset("usr_1", "b")).toBe(0);          // floor-safe
  expect(await assets.likeAsset("usr_1", "a")).toBe(1);

  expect((await assets.likedByUser("usr_1", ["a", "b", "c"])).sort()).toEqual(["a"]);
  expect(await assets.likedByUser("usr_1", [])).toEqual([]);

  // a liked (1) first; then zero-like rows by locally_cached DESC (c), then id ASC (b).
  const page = await assets.browseByLikes({ limit: 10, offset: 0 });
  expect(page.map((r) => r.id)).toEqual(["a", "c", "b"]);
  expect(page[0].like_count).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/d1-real-schema.test.ts -t "0020 store"`
Expected: FAIL — `assets.likeAsset is not a function`.

- [ ] **Step 3a: Add types** — in `src/types.ts`, add `like_count` to `AssetRow`:

```ts
export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  model_used: string | null; width: number | null; height: number | null;
  mime: string | null; source_url: string | null; locally_cached: number;
  like_count: number;
}
```

And add four methods to the `AssetStore` interface (place after `bumpServeCount`):

```ts
  /** Idempotent like; returns the post-state like_count. */
  likeAsset(userId: string, id: string): Promise<number>;
  /** Idempotent unlike; returns the post-state like_count. */
  unlikeAsset(userId: string, id: string): Promise<number>;
  /** Subset of `ids` the user has liked (for the per-image `liked` flag). */
  likedByUser(userId: string, ids: string[]): Promise<string[]>;
  /** Likes-ranked browse page; unscoped excludes collection assets. */
  browseByLikes(i: { limit: number; offset: number; collectionId?: string }): Promise<LibraryAssetRow[]>;
```

- [ ] **Step 3b: Add `like_count` to `ASSET_COLS`** — in `src/d1.ts`:

```ts
const ASSET_COLS =
  "id, prompt, source, source_id, model_used, width, height, mime, source_url, locally_cached, like_count";
```

- [ ] **Step 3c: Implement the four methods** — in `src/d1.ts`, inside the `assets` store object (after `bumpServeCount`):

```ts
    async likeAsset(userId, id) {
      await db.prepare("INSERT OR IGNORE INTO likes (user_id, asset_id) VALUES (?, ?)").bind(userId, id).run();
      const row = await db.prepare("SELECT like_count FROM live_assets WHERE id = ?").bind(id).first<{ like_count: number }>();
      return row?.like_count ?? 0;
    },
    async unlikeAsset(userId, id) {
      await db.prepare("DELETE FROM likes WHERE user_id = ? AND asset_id = ?").bind(userId, id).run();
      const row = await db.prepare("SELECT like_count FROM live_assets WHERE id = ?").bind(id).first<{ like_count: number }>();
      return row?.like_count ?? 0;
    },
    async likedByUser(userId, ids) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT asset_id FROM likes WHERE user_id = ? AND asset_id IN (${marks})`
      ).bind(userId, ...ids).all<{ asset_id: string }>();
      return (results ?? []).map((r) => r.asset_id);
    },
    async browseByLikes({ limit, offset, collectionId }) {
      // Unscoped browse must never surface collection assets (parity with searchAssets).
      const cond = collectionId ? "collection_id = ?" : "collection_id IS NULL";
      const args: unknown[] = collectionId ? [collectionId] : [];
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at FROM live_assets WHERE ${cond} ORDER BY like_count DESC, locally_cached DESC, id ASC LIMIT ? OFFSET ?`
      ).bind(...args, limit, offset).all<LibraryAssetRow>();
      return results ?? [];
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/d1-real-schema.test.ts -t "0020 store"`
Expected: PASS. Also run the whole real-schema file to confirm no regressions: `npx vitest run test/d1-real-schema.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/d1.ts test/d1-real-schema.test.ts
git commit -m "feat(d1): like/unlike/likedByUser/browseByLikes + like_count column"
```

---

## Task 3: library.ts — sort, like_count/liked projection, like/unlike handlers

**Files:**
- Modify: `src/library.ts`
- Modify: `test/fakes.ts` (likes fakes, `like_count` on rows, search limiters)
- Test: `test/library.test.ts` (append + update the exact-shape assertion)

**Interfaces:**
- Consumes: `AssetStore` methods from Task 2.
- Produces:
  - `handleLibrarySearch(url: URL, s: Services, cfg: LibrarySearchCfg, userId?: string | null): Promise<Response>` — new 4th param.
  - `handleLikeAsset(id: string, userId: string, s: Services): Promise<Response>` → `{ liked: true, like_count }` or 404.
  - `handleUnlikeAsset(id: string, userId: string, s: Services): Promise<Response>` → `{ liked: false, like_count }` or 404.
  - Response images carry `like_count: number` always, and `liked: boolean` only when `userId` is provided.

- [ ] **Step 1a: Update `test/fakes.ts`** — add likes state and methods to the `assets` fake, `like_count` to the rows it returns, and the two new limiters. Near the top of `fakeServices` (with the other `const … = new Map()` decls) add:

```ts
  const likes = new Set<string>();           // `${userId} ${assetId}`
  const likeCounts = new Map<string, number>();
  const lk = (userId: string, id: string) => `${userId} ${id}`;
```

In the `assets` fake, change `searchAssets` and `getAssetsByIds` so returned rows carry `like_count`:

```ts
      searchAssets: async (i) => { searchCalls.push(i); return libraryRows.slice(i.offset, i.offset + i.limit)
        .map((r: any) => ({ ...r, like_count: likeCounts.get(r.id) ?? 0 })); },
      getAssetsByIds: async (ids) => ids.flatMap((id) => {
        const r = assets.get(id);
        return r ? [{ ...(r as any), like_count: likeCounts.get(id) ?? 0 } as LibraryAssetRow] : [];
      }),
```

Because `AssetRow` now requires `like_count`, add `like_count: 0,` to the row literal the `insertGenerated` fake builds (find the `locally_cached: 0,` line inside that `const row = { … }` and add `like_count: 0,` beside it) so the fake stays type-honest.

And append these four methods to the `assets` fake (after `previewsByCollections`):

```ts
      likeAsset: async (userId, id) => {
        if (!likes.has(lk(userId, id))) { likes.add(lk(userId, id)); likeCounts.set(id, (likeCounts.get(id) ?? 0) + 1); }
        return likeCounts.get(id) ?? 0;
      },
      unlikeAsset: async (userId, id) => {
        if (likes.has(lk(userId, id))) { likes.delete(lk(userId, id)); likeCounts.set(id, Math.max(0, (likeCounts.get(id) ?? 0) - 1)); }
        return likeCounts.get(id) ?? 0;
      },
      likedByUser: async (userId, ids) => ids.filter((id) => likes.has(lk(userId, id))),
      browseByLikes: async ({ limit, offset, collectionId }) => {
        const scope = libraryRows.filter((r: any) => collectionId ? r.collection_id === collectionId : (r.collection_id == null));
        const sorted = [...scope].sort((a: any, b: any) =>
          (likeCounts.get(b.id) ?? 0) - (likeCounts.get(a.id) ?? 0) || (b.locally_cached - a.locally_cached) || (a.id < b.id ? -1 : 1));
        return sorted.slice(offset, offset + limit).map((r: any) => ({ ...r, like_count: likeCounts.get(r.id) ?? 0 }));
      },
```

Add the two limiters next to `rateLimiter` / `rateLimiterPaid`:

```ts
    rateLimiterSearch: { limit: async () => true },
    rateLimiterSearchUser: { limit: async () => true },
```

Finally expose the likes maps for assertions (near the `(base as any)._libraryRows = …` lines):

```ts
  (base as any)._likeCounts = likeCounts;
```

- [ ] **Step 1b: Write the failing tests** — append to `test/library.test.ts`. Also update the existing exact-shape test (the `it("search: response projects to documented public shape…")` block) by adding `like_count: 0,` to its `toEqual({...})` object.

```ts
import { handleLikeAsset, handleUnlikeAsset } from "../src/library";

it("search: images carry like_count; liked only when a user is supplied", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow({ id: "a1" }));
  (s as any)._likeCounts.set("a1", 3);

  const anon: any = await (await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg)).json();
  expect(anon.images[0].like_count).toBe(3);
  expect(anon.images[0]).not.toHaveProperty("liked");

  const authed: any = await (await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg, "usr_1")).json();
  expect(authed.images[0]).toMatchObject({ like_count: 3, liked: false });
  await s.assets.likeAsset("usr_1", "a1");
  const after: any = await (await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg, "usr_1")).json();
  expect(after.images[0].liked).toBe(true);
});

it("search: empty q browses by likes (browseByLikes), not the recency LIKE scan", async () => {
  const s = fakeServices();
  for (const id of ["a", "b", "c"]) (s as any)._libraryRows.push(libRow({ id }));
  (s as any)._likeCounts.set("c", 5);
  const j: any = await (await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg)).json();
  expect(j.images[0].id).toBe("c");                       // most-liked first
  expect((s as any)._searchCalls.length).toBe(0);          // did NOT use searchAssets
});

it("search: sort=liked reorders matches by like_count; sort=match keeps relevance", async () => {
  const s = fakeServices();
  // Vector-path hydration reads the `_assets` map (via getAssetsByIds), and vector
  // hits come from `_matches` — mirror the existing "semantic search" tests.
  (s as any)._matches.push({ id: "m2", score: 0.95 }, { id: "m1", score: 0.90 }); // m2 more relevant
  (s as any)._assets.set("m1", libRow({ id: "m1" }));
  (s as any)._assets.set("m2", libRow({ id: "m2" }));
  (s as any)._likeCounts.set("m1", 10);                                            // but m1 more liked
  const liked: any = await (await handleLibrarySearch(new URL("https://x/v1/library?q=fox&sort=liked"), s, cfg)).json();
  expect(liked.images.map((i: any) => i.id)).toEqual(["m1", "m2"]);                // likes win
  const match: any = await (await handleLibrarySearch(new URL("https://x/v1/library?q=fox&sort=match"), s, cfg)).json();
  expect(match.images.map((i: any) => i.id)).toEqual(["m2", "m1"]);                // relevance preserved
});

it("like: 404 for unknown asset, then like -> unlike round-trips the count", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow({ id: "a1" }));
  (s.assets as any).getAsset = async (id: string) => (s as any)._libraryRows.find((r: any) => r.id === id) ?? null;

  expect((await handleLikeAsset("nope", "usr_1", s)).status).toBe(404);
  const liked: any = await (await handleLikeAsset("a1", "usr_1", s)).json();
  expect(liked).toEqual({ liked: true, like_count: 1 });
  const unliked: any = await (await handleUnlikeAsset("a1", "usr_1", s)).json();
  expect(unliked).toEqual({ liked: false, like_count: 0 });
});
```

Also update the `libRow` helper at the top of `test/library.test.ts` to include `like_count`:

```ts
function libRow(over: Partial<LibraryAssetRow> = {}): LibraryAssetRow {
  return { id: "a1", prompt: "a fox", source: "pd12m", source_id: null,
    model_used: "flux", width: 10, height: 20, like_count: 0,
    mime: "image/webp", source_url: null, locally_cached: 1, created_at: "2026-07-03 00:00:00", ...over };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/library.test.ts -t "like_count"`
Expected: FAIL — `like_count` undefined / `handleLikeAsset` not exported.

- [ ] **Step 3: Rewrite `src/library.ts`** — replace `publicAsset` and `handleLibrarySearch`, and add the two handlers. `publicAsset`:

```ts
function publicAsset(r: LibraryAssetRow, baseUrl: string | undefined, liked?: boolean) {
  const u = assetUrls(r, baseUrl);
  return {
    id: r.id, prompt: r.prompt, thumb_url: u.thumb_url, medium_url: u.medium_url,
    url: u.url, width: r.width, height: r.height, mime: r.mime,
    model_used: r.model_used, source: r.source, created_at: r.created_at,
    original_url: u.original_url, like_count: r.like_count,
    ...(liked === undefined ? {} : { liked }),
  };
}
```

Replace `handleLibrarySearch` (keep the existing param parsing for `q`/`limit`/`offset`/`collection` verbatim; only the branching below changes). Full function:

```ts
export async function handleLibrarySearch(
  url: URL, s: Services, cfg: LibrarySearchCfg, userId?: string | null
): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_Q_LEN) {
    return Response.json({ error: `q must be at most ${MAX_Q_LEN} characters` }, { status: 400 });
  }
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");

  let limit = 24;
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n)) return Response.json({ error: "limit must be an integer" }, { status: 400 });
    limit = Math.min(60, Math.max(1, n));
  }
  let offset = 0;
  if (rawOffset != null) {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) {
      return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    }
    offset = n;
  }

  const sortParam = url.searchParams.get("sort");
  const sort: "match" | "liked" = sortParam === "match" || sortParam === "liked" ? sortParam : (q ? "match" : "liked");

  let coll: CollectionRow | null = null;
  const collectionId = url.searchParams.get("collection");
  if (collectionId) {
    coll = await s.collections.get(collectionId);
    if (!coll) return Response.json({ error: "unknown collection" }, { status: 404 });
    try { await s.collections.bumpSearchCount(coll.id); } catch (e) { console.error("bumpSearchCount failed", e); }
  }

  // Project rows to the public shape, attaching the per-user `liked` flag when authed.
  const project = async (rows: LibraryAssetRow[], has_more: boolean): Promise<Response> => {
    let likedSet: Set<string> | null = null;
    if (userId) likedSet = new Set(await s.assets.likedByUser(userId, rows.map((r) => r.id)));
    const images = rows.map((r) => publicAsset(r, cfg.assetBaseUrl, likedSet ? likedSet.has(r.id) : undefined));
    return Response.json({ images, has_more });
  };

  if (q) {
    try {
      const vec = await s.embedder.textEmbed(coll ? combinedPrompt(q, coll.theme_prompt) : q);
      const matches = coll
        ? await s.vectorize.queryNamespace(vec, coll.id, SEARCH_TOP_K)
        : await s.vectorize.query(vec, SEARCH_TOP_K);
      const relevant = matches.filter((m) => m.score >= cfg.floorSimMin);

      if (sort === "liked") {
        // Hydrate the whole relevant set, order by like_count, then paginate.
        const rows = await s.assets.getAssetsByIds(relevant.map((m) => m.id));
        rows.sort((a, b) => b.like_count - a.like_count || (a.id < b.id ? -1 : 1));
        return await project(rows.slice(offset, offset + limit), rows.length > offset + limit);
      }
      const page = relevant.slice(offset, offset + limit);
      const rows = await s.assets.getAssetsByIds(page.map((m) => m.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = page.flatMap((m) => (byId.has(m.id) ? [byId.get(m.id)!] : [])); // orphan vector: skip
      return await project(ordered, relevant.length > offset + limit);
    } catch (e) {
      console.warn("semantic library search failed; falling back to LIKE", e);
    }
  }

  // Empty q -> likes-ranked browse; q-present fallback -> LIKE scan (existing behavior).
  const rows = q
    ? await s.assets.searchAssets({ q, limit: limit + 1, offset, ...(coll ? { collectionId: coll.id } : {}) })
    : await s.assets.browseByLikes({ limit: limit + 1, offset, ...(coll ? { collectionId: coll.id } : {}) });
  return await project(rows.slice(0, limit), rows.length > limit);
}
```

Add the two like handlers (place after `handleLibrarySearch`):

```ts
export async function handleLikeAsset(id: string, userId: string, s: Services): Promise<Response> {
  if (!(await s.assets.getAsset(id))) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ liked: true, like_count: await s.assets.likeAsset(userId, id) });
}

export async function handleUnlikeAsset(id: string, userId: string, s: Services): Promise<Response> {
  if (!(await s.assets.getAsset(id))) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ liked: false, like_count: await s.assets.unlikeAsset(userId, id) });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/library.test.ts`
Expected: PASS (new tests + the updated exact-shape test). If the shape test still fails, confirm `like_count: 0` was added to its `toEqual`.

- [ ] **Step 5: Commit**

```bash
git add src/library.ts test/fakes.ts test/library.test.ts
git commit -m "feat(library): sort=liked|match, like_count/liked projection, like/unlike handlers"
```

---

## Task 4: index.ts routing — open library to anon, like/unlike routes, rate limiters

**Files:**
- Modify: `src/types.ts` (`Env` + `Services` gain the two limiters)
- Modify: `src/index.ts`
- Modify: `wrangler.toml`
- Test: `test/router.test.ts` (append + update two obsolete gate tests)

**Interfaces:**
- Consumes: `handleLibrarySearch(…, userId)`, `handleLikeAsset`, `handleUnlikeAsset` from Task 3; `Principal` from `./session`.
- Produces: `Services.rateLimiterSearch` / `rateLimiterSearchUser` (type `RateLimiter`); `Env.RATE_LIMITER_SEARCH` / `RATE_LIMITER_SEARCH_USER` (type `RateLimitBinding`).

- [ ] **Step 1: Write/adjust the failing tests** — in `test/router.test.ts`:

Replace the two now-obsolete gate tests (currently at lines ~161-169, "library: now gated -> 401…" and "library download: now gated -> 401…") with:

```ts
it("library: open to anonymous even when master is set -> 200", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"),
    fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
});

it("library download: open to anonymous; unknown id -> 404 (not 401)", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library/a1/download"),
    fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});
```

Append new tests:

```ts
it("library: anonymous over the per-IP cap -> 429", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"),
    fakeEnv({ MASTER_API_KEY: "master", RATE_LIMITER_SEARCH: { limit: async () => ({ success: false }) } }),
    { waitUntil: () => {} } as any);
  expect(res.status).toBe(429);
});

it("like: POST/DELETE require a principal -> 401 when anonymous (master set)", async () => {
  for (const method of ["POST", "DELETE"]) {
    const res = await worker.fetch(new Request("https://x/v1/library/a1/like", { method }),
      fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
    expect(res.status).toBe(401);
  }
});

it("like: authenticated POST reaches the handler — 404 on unknown id, not 401", async () => {
  // DEV_MODE=true yields a dev principal, so auth passes; the fakeEnv DB stub
  // returns null from getAsset, so the handler 404s. A 401 here would mean auth
  // failed — asserting 404 proves the authenticated like path is wired.
  const res = await worker.fetch(new Request("https://x/v1/library/a1/like", { method: "POST" }),
    fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});
```

> Note: `test/router.test.ts`'s `fakeEnv` DB stub returns `null` for every query, so `getAsset` is null and a real like 404s — that's expected and still proves the route resolved a principal (a 401 would mean auth failed). Deeper like behavior is covered by Task 3's fakes and Task 2's real schema.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/router.test.ts -t "library"`
Expected: FAIL — old behavior returns 401 where we now assert 200/404/429; `rateLimiterSearch` undefined.

- [ ] **Step 3a: Extend `Env` and `Services`** — in `src/types.ts`. Add to `Services` (after `rateLimiterPaid`):

```ts
  rateLimiterSearch: RateLimiter; rateLimiterSearchUser: RateLimiter;
```

Add to `Env` (after `RATE_LIMITER_PAID`):

```ts
  RATE_LIMITER_SEARCH?: RateLimitBinding;
  RATE_LIMITER_SEARCH_USER?: RateLimitBinding;
```

- [ ] **Step 3b: Build the limiters** — in `src/index.ts` `buildServices`, after the `rateLimiterPaid` const:

```ts
  const rateLimiterSearch: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER_SEARCH) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER_SEARCH.limit({ key });
      return success;
    },
  };
  const rateLimiterSearchUser: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER_SEARCH_USER) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER_SEARCH_USER.limit({ key });
      return success;
    },
  };
```

And add them to the returned object (after `rateLimiter, rateLimiterPaid,`):

```ts
    rateLimiterSearch, rateLimiterSearchUser,
```

- [ ] **Step 3c: Import `Principal` and add a rate-limit helper** — in `src/index.ts`, update the session import and the library handler import:

```ts
import { handleLibrarySearch, handleLibraryDownload, handleLikeAsset, handleUnlikeAsset } from "./library";
import { resolveApiPrincipal, resolveSession, type Principal } from "./session";
```

Add a helper (top-level, near `genKey`):

```ts
// Public library read access: anonymous is allowed but rate-limited per IP;
// authenticated callers get the looser per-user limiter.
async function libraryAccess(
  request: Request, env: Env, services: Services
): Promise<{ principal: Principal | null; ok: boolean }> {
  const principal = await resolveApiPrincipal(request, env, services);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ok = principal
    ? await services.rateLimiterSearchUser.limit(`u:${principal.userId}`)
    : await services.rateLimiterSearch.limit(`ip:${ip}`);
  return { principal, ok };
}
```

- [ ] **Step 3d: Rewire the routes** — in `src/index.ts`. Replace the library GET block:

```ts
      if (url.pathname === "/v1/library" && request.method === "GET") {
        const { principal, ok } = await libraryAccess(request, env, services);
        if (!ok) return Response.json({ error: "rate limited" }, { status: 429 });
        return await handleLibrarySearch(url, services, libraryCfg, principal?.userId ?? null);
      }
```

Replace the library download block (drop the 401 gate, add rate-limit):

```ts
      const dl = url.pathname.match(/^\/v1\/library\/([^/]+)\/download$/);
      if (dl && request.method === "GET") {
        const { ok } = await libraryAccess(request, env, services);
        if (!ok) return Response.json({ error: "rate limited" }, { status: 429 });
        let id: string;
        try {
          id = decodeURIComponent(dl[1]);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        return await handleLibraryDownload(id, services, libraryCfg, (u) => fetch(u));
      }
```

Add the like/unlike route immediately after the download block:

```ts
      const likeM = url.pathname.match(/^\/v1\/library\/([^/]+)\/like$/);
      if (likeM && (request.method === "POST" || request.method === "DELETE")) {
        const principal = await resolveApiPrincipal(request, env, services);
        if (!principal) return Response.json({ error: "login required" }, { status: 401 });
        let id: string;
        try { id = decodeURIComponent(likeM[1]); } catch { return new Response("Not found", { status: 404 }); }
        return request.method === "POST"
          ? await handleLikeAsset(id, principal.userId, services)
          : await handleUnlikeAsset(id, principal.userId, services);
      }
```

- [ ] **Step 3e: Add the bindings** — in `wrangler.toml`, after the `RATE_LIMITER_PAID` binding block:

```toml
# Anonymous library search, keyed by CF-Connecting-IP. namespace_id must be
# unique across the account's ratelimit namespaces.
[[unsafe.bindings]]
name = "RATE_LIMITER_SEARCH"
type = "ratelimit"
namespace_id = "1003"
simple = { limit = 30, period = 60 }

# Logged-in library search, keyed by userId — looser than anonymous.
[[unsafe.bindings]]
name = "RATE_LIMITER_SEARCH_USER"
type = "ratelimit"
namespace_id = "1004"
simple = { limit = 60, period = 60 }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/router.test.ts`
Expected: PASS. Then the full suite: `npm test` — Expected: PASS (watch for any other test that assumed the library login gate; there should be none beyond the two we updated).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/index.ts wrangler.toml test/router.test.ts
git commit -m "feat(routes): open /v1/library to anon (rate-limited) + like/unlike routes"
```

---

## Task 5: SPA — heart control + sort toggle in the library page

**Files:**
- Modify: `public/index.html` (inline `<script>` + the library view markup + inline CSS)

**Interfaces:**
- Consumes: `GET /v1/library?sort=liked|match` (now returns `like_count` + `liked`), `POST/DELETE /v1/library/:id/like`, existing `currentUser` global (`null` when logged out) and the existing login-redirect flow.
- Produces: no exports (browser code). Verified manually (the repo has no JS test harness).

- [ ] **Step 1: Add the sort toggle markup** — in `public/index.html`, in the library view near the search input (`id="library-search"` / the row around line ~2885). Add after the search input element:

```html
<div class="library-sort" role="group" aria-label="Sort library">
  <button type="button" id="lib-sort-liked" class="sort-btn is-active" aria-pressed="true" onclick="setLibrarySort('liked')">Most liked</button>
  <button type="button" id="lib-sort-match" class="sort-btn" aria-pressed="false" disabled onclick="setLibrarySort('match')">Best match</button>
</div>
```

- [ ] **Step 2: Add minimal CSS** — in the `/* ====== Library ====== */` style block (around line 420), append:

```css
.library-sort { display: inline-flex; gap: .25rem; margin-left: .5rem; }
.sort-btn { font: inherit; padding: .3rem .7rem; border: 1px solid var(--line); background: transparent; color: var(--ink); border-radius: 999px; cursor: pointer; }
.sort-btn.is-active { background: var(--red); color: #fff; border-color: var(--red); }
.sort-btn:disabled { opacity: .45; cursor: not-allowed; }
.like-btn { display: inline-flex; align-items: center; gap: .3rem; border: none; background: transparent; color: var(--ink); cursor: pointer; font: inherit; padding: .2rem .4rem; }
.like-btn .heart { font-size: 1.05rem; line-height: 1; }
.like-btn.is-liked .heart { color: var(--red); }
```

- [ ] **Step 3: Add sort state + `setLibrarySort`** — in the `<script>`, near the other library globals (`libQuery`, `libOffset`, …):

```js
    let libSort = 'liked';               // 'liked' (default) | 'match'
    let libUserPickedSort = false;       // did the user explicitly choose?

    function setLibrarySort(sort) {
      libSort = sort; libUserPickedSort = true;
      document.getElementById('lib-sort-liked').classList.toggle('is-active', sort === 'liked');
      document.getElementById('lib-sort-liked').setAttribute('aria-pressed', String(sort === 'liked'));
      document.getElementById('lib-sort-match').classList.toggle('is-active', sort === 'match');
      document.getElementById('lib-sort-match').setAttribute('aria-pressed', String(sort === 'match'));
      searchLibrary(libQuery);
    }
```

- [ ] **Step 4: Make the query default the sort + enable "Best match"** — replace `searchLibrary`:

```js
    function searchLibrary(q) {
      libQuery = q; libOffset = 0;
      const matchBtn = document.getElementById('lib-sort-match');
      if (matchBtn) matchBtn.disabled = !q;                // "Best match" only means something with a query
      if (!libUserPickedSort) {                            // auto-default: match when searching, liked when browsing
        libSort = q ? 'match' : 'liked';
        setSortButtons();
      } else if (!q && libSort === 'match') {              // no query -> match is meaningless, fall back
        libSort = 'liked'; setSortButtons();
      }
      loadLibrary(false);
    }
    function setSortButtons() {
      const liked = document.getElementById('lib-sort-liked'), match = document.getElementById('lib-sort-match');
      if (!liked || !match) return;
      liked.classList.toggle('is-active', libSort === 'liked'); liked.setAttribute('aria-pressed', String(libSort === 'liked'));
      match.classList.toggle('is-active', libSort === 'match'); match.setAttribute('aria-pressed', String(libSort === 'match'));
    }
```

> `onLibraryInput` calls `searchLibrary(value.trim())` on debounce; leave it unchanged. Because a user typing hasn't "picked a sort", keep `libUserPickedSort` reset to `false` when the search box is cleared: in `onLibraryInput`, before the debounce, add `if (!value.trim()) libUserPickedSort = false;`.

- [ ] **Step 5: Send `sort` in `loadLibrary`** — in `loadLibrary`, where params are built:

```js
        const params = new URLSearchParams({ limit: LIB_PAGE_SIZE, offset: libOffset, sort: libSort });
        if (libQuery) params.set('q', libQuery);
        const res = await fetch('/v1/library?' + params, { credentials: 'same-origin' });
```

(`credentials: 'same-origin'` makes the session cookie ride along so `liked` comes back for logged-in users.)

- [ ] **Step 6: Render the heart on cards** — replace `libraryCard` so it includes the like button and stores id for the toggle:

```js
    function libraryCard(img) {
      const thumb = img.thumb_url || img.medium_url || img.url;
      const tags = [img.model_used, img.source].filter(Boolean)
        .map(t => '<span class="library-tag">' + escapeHtml(t) + '</span>').join('');
      const original = img.original_url
        ? '<a class="library-original" href="' + escapeHtml(img.original_url) + '" target="_blank" rel="noopener">Original ↗</a>'
        : '';
      const liked = img.liked ? ' is-liked' : '';
      const like = '<button type="button" class="like-btn' + liked + '" data-id="' + escapeHtml(img.id) +
        '" aria-pressed="' + (img.liked ? 'true' : 'false') + '" onclick="toggleLike(this)">' +
        '<span class="heart">' + (img.liked ? '♥' : '♡') + '</span>' +
        '<span class="like-count">' + (img.like_count || 0) + '</span></button>';
      return '<div class="library-card">' +
        '<img class="library-thumb" loading="lazy" src="' + escapeHtml(thumb) + '" alt="' + escapeHtml(img.prompt) + '">' +
        '<div class="library-meta">' +
          '<p class="library-prompt" title="' + escapeHtml(img.prompt) + '">' + escapeHtml(img.prompt) + '</p>' +
          '<div class="library-tags">' + tags + '</div>' +
          '<div class="library-actions">' + like +
            '<a class="library-download" href="/v1/library/' + encodeURIComponent(img.id) + '/download">Download</a>' + original +
          '</div>' +
        '</div></div>';
    }
```

- [ ] **Step 7: Add `toggleLike`** — in the `<script>` (near `libraryCard`):

```js
    async function toggleLike(btn) {
      if (!currentUser) {                                  // route logged-out users into the login flow
        sessionStorage.setItem('wagmi_return', location.hash || '#/library');
        location.hash = '#/account';
        return;
      }
      const id = btn.getAttribute('data-id');
      const wasLiked = btn.getAttribute('aria-pressed') === 'true';
      btn.disabled = true;
      try {
        const res = await fetch('/v1/library/' + encodeURIComponent(id) + '/like',
          { method: wasLiked ? 'DELETE' : 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        btn.classList.toggle('is-liked', data.liked);
        btn.setAttribute('aria-pressed', String(data.liked));
        btn.querySelector('.heart').textContent = data.liked ? '♥' : '♡';
        btn.querySelector('.like-count').textContent = data.like_count;
      } catch (_) {
        // leave the button as-is on failure
      } finally {
        btn.disabled = false;
      }
    }
```

- [ ] **Step 8: Manual verification** (no JS test harness in this repo). Use the running-locally skill's recipe (`wrangler dev --local` in `projects/worker` with `.dev.vars` `DEV_MODE=true`). Then:

```bash
# Anonymous browse defaults to sort=liked and returns like_count on each image:
curl -s "http://localhost:8787/v1/library?limit=2" | python3 -m json.tool | grep -E "like_count|liked" | head
# Anonymous like is rejected:
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:8787/v1/library/<some-id>/like"   # expect 401
# Dev principal (DEV_MODE) can like an existing id and the count moves:
curl -s -X POST "http://localhost:8787/v1/library/<some-id>/like"    # expect {"liked":true,"like_count":1}
curl -s -X DELETE "http://localhost:8787/v1/library/<some-id>/like"  # expect {"liked":false,"like_count":0}
```

Then load `http://localhost:8787/#/library` in a browser and confirm: default view is likes-ranked, the "Best match" toggle is disabled until you type a query, hearts render with counts, and clicking a heart while logged out sends you to the account/login page.

> Offline note (per the running-locally skill): with no Vectorize/Workers AI locally, semantic search falls back to the LIKE scan and the empty-query browse uses `browseByLikes` against the seeded demo rows — both work offline.

- [ ] **Step 9: Commit**

```bash
git add public/index.html
git commit -m "feat(spa): library heart + Most liked/Best match sort toggle"
```

---

## Final verification

- [ ] Run the full suite: `npm test` — Expected: all PASS.
- [ ] `git log --oneline feat/public-library-likes` shows the spec commit + five task commits.
- [ ] Spot-check `wrangler.toml`: `RATE_LIMITER_SEARCH` (1003) and `RATE_LIMITER_SEARCH_USER` (1004) present; existing floor `[vars]` still absent (per the 2026-07-18 floor decision — do not reintroduce any `[vars]` overrides here).
- [ ] Deploy note (out of plan scope, for the operator): migration `0020` must be applied to remote D1 (`wrangler d1 migrations apply wagmiphotos --remote`) before or with the Worker deploy, since the Worker's reads now select `like_count`.
