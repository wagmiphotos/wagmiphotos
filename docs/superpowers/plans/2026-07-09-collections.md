# Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BYOK-gated themed collections: owners generate themed images into a collection (also joining the global library), anyone with the ID scopes searches to it, per-asset serve counts surface to owners, and the backfill never generates for collections.

**Architecture:** New `collections` D1 table + `collection_id`/`serve_count` asset columns (migration 0015). One new namespaced Vectorize index `wagmiphotos-coll` (namespace = collection id) dual-written alongside the existing 3 shards. Scoped requests embed `prompt + ", " + theme`, query only the collections namespace, never write the `queries` demand table (that is the entire backfill-exclusion mechanism), and only the owner's BYOK generates on miss. Six management routes + a `collection` parameter on `/v1/images/generations` and `/v1/library`. SPA gets an account Collections card and a playground picker.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, Vectorize (namespaces), vitest with fake stores, single-file SPA (`public/index.html`).

**Spec:** `docs/superpowers/specs/2026-07-09-collections-design.md` (approved 2026-07-09).

## Global Constraints

- Max **20 collections per user**; name ≤ **80** chars; theme_prompt ≤ **500** chars; combined prompt (`prompt + ", " + theme`) ≤ **2000** chars (`MAX_PROMPT_LEN`).
- Collection id format: `col_` + 20 lowercase base32 chars (`abcdefghijklmnopqrstuvwxyz234567`), generated with `crypto.getRandomValues`.
- `serve_count` and `collection_id` must stay **out of `ASSET_COLS`** public selections on generation/library responses (same rule as `created_by`); `serve_count` is exposed only via owner-facing collections endpoints, `collection_id` only via `shared_cache.collection` echo.
- Scoped requests must **never call `s.queries.recordQuery`** (backfill exclusion) and always return `generation_queued: false`.
- `serve_count` increments only when `/v1/images/generations` returns an asset as `hit` or `approximate` (never `generated`, never library reads); increments and namespace upserts are best-effort (`try/catch` + `console.error`), never failing the request.
- All vector deletes are best-effort; the D1 tombstone (`dead_at`) is the source of truth.
- Migration rule (from 0008/0014): any migration adding `assets` columns must `DROP VIEW IF EXISTS live_assets` and recreate it.
- `contract.json` must NOT change (worker-only feature; Python backfill untouched).
- Working directory for all commands: `projects/worker`. Test command: `npx vitest run` (or `npm test`).
- Commit after every task; messages follow the repo's `feat(scope): ...` style.

---

### Task 1: Migration 0015 + D1 collection store + asset-store extensions

**Files:**
- Create: `projects/worker/migrations/0015_collections.sql`
- Modify: `projects/worker/src/types.ts`
- Modify: `projects/worker/src/d1.ts`
- Modify: `projects/worker/src/index.ts` (buildServices destructure only)
- Modify: `projects/worker/test/fakes.ts`
- Test: `projects/worker/test/d1.test.ts`

**Interfaces:**
- Consumes: existing `makeD1Stores(db)`, `ASSET_COLS`, `live_assets` view.
- Produces (later tasks rely on these exact names):
  - `CollectionRow { id, owner_user_id, name, theme_prompt, created_at, updated_at }`
  - `CollectionSummary extends CollectionRow { image_count: number; total_serves: number }`
  - `CollectionImageRow extends LibraryAssetRow { serve_count: number }`
  - `CollectionStore { create, get, listByOwner, countByOwner, patch, delete }`
  - `AssetStore` additions: `listByCollection`, `getCollectionMember`, `tombstoneAsset`, `tombstoneByCollection`, `bumpServeCount`; `searchAssets` gains optional `collectionId`; `insertGenerated` gains `collectionId: string | null`
  - `Services.collections: CollectionStore`

- [ ] **Step 1: Write the migration**

Create `projects/worker/migrations/0015_collections.sql`:

```sql
-- Collections: owner-managed themed groupings of BYOK-generated images
-- (spec docs/superpowers/specs/2026-07-09-collections-design.md). The id is
-- unguessable ('col_' + 20 random base32 chars) and doubles as the share
-- capability: anyone who knows it may scope searches to the collection.
CREATE TABLE IF NOT EXISTS collections (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  theme_prompt  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);

-- collection_id: NULL for every pre-existing asset (plain library asset).
-- serve_count: how many times /v1/images/generations returned this asset as
-- hit/approximate. Owner-facing stat only — like created_by, neither column
-- joins ASSET_COLS, so public read paths never select them.
ALTER TABLE assets ADD COLUMN collection_id TEXT;
ALTER TABLE assets ADD COLUMN serve_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_assets_collection ON assets(collection_id) WHERE collection_id IS NOT NULL;
-- 0008's note: a migration that adds asset columns must recreate live_assets
-- so its SELECT * re-expands to expose them to every read path.
DROP VIEW IF EXISTS live_assets;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
```

- [ ] **Step 2: Write failing tests for the new D1 store methods**

Append to `projects/worker/test/d1.test.ts` (the file's existing `fakeDb(firstResult, allResults)` helper is already defined at the top):

```ts
// ---- collections (migration 0015) ----

it("collections.create inserts id/owner/name/theme", async () => {
  const { db, calls } = fakeDb();
  const { collections } = makeD1Stores(db);
  await collections.create({ id: "col_abc", ownerUserId: "usr_1", name: "Retro posters", themePrompt: "retro poster style" });
  expect(calls[0].sql).toContain("INSERT INTO collections");
  expect(calls[0].args).toEqual(["col_abc", "usr_1", "Retro posters", "retro poster style"]);
});

it("collections.get selects by id, returns null when missing", async () => {
  const row = { id: "col_abc", owner_user_id: "usr_1", name: "n", theme_prompt: "t", created_at: "x", updated_at: "x" };
  const { db, calls } = fakeDb(row);
  const { collections } = makeD1Stores(db);
  expect((await collections.get("col_abc"))?.owner_user_id).toBe("usr_1");
  expect(calls[0].sql).toContain("FROM collections WHERE id = ?");
  const { db: db2 } = fakeDb(null);
  expect(await makeD1Stores(db2).collections.get("nope")).toBeNull();
});

it("collections.listByOwner aggregates image_count and total_serves over live_assets", async () => {
  const { db, calls } = fakeDb(null, [{ id: "col_abc", owner_user_id: "usr_1", name: "n", theme_prompt: "", created_at: "x", updated_at: "x", image_count: 2, total_serves: 7 }]);
  const { collections } = makeD1Stores(db);
  const rows = await collections.listByOwner("usr_1");
  expect(rows[0].total_serves).toBe(7);
  expect(calls[0].sql).toContain("LEFT JOIN live_assets");
  expect(calls[0].sql).toContain("SUM(a.serve_count)");
  expect(calls[0].args).toEqual(["usr_1"]);
});

it("collections.countByOwner counts rows", async () => {
  const { db, calls } = fakeDb({ n: 3 });
  const { collections } = makeD1Stores(db);
  expect(await collections.countByOwner("usr_1")).toBe(3);
  expect(calls[0].sql).toContain("COUNT(*)");
});

it("collections.patch updates only provided fields plus updated_at", async () => {
  const { db, calls } = fakeDb();
  const { collections } = makeD1Stores(db);
  await collections.patch("col_abc", { themePrompt: "new theme" });
  expect(calls[0].sql).toContain("theme_prompt = ?");
  expect(calls[0].sql).not.toContain("name = ?");
  expect(calls[0].sql).toContain("updated_at = datetime('now')");
  expect(calls[0].args).toEqual(["new theme", "col_abc"]);
});

it("collections.delete deletes by id", async () => {
  const { db, calls } = fakeDb();
  const { collections } = makeD1Stores(db);
  await collections.delete("col_abc");
  expect(calls[0].sql).toContain("DELETE FROM collections WHERE id = ?");
});

// ---- asset-store collection extensions ----

it("listByCollection selects live rows with serve_count, newest first", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.listByCollection({ collectionId: "col_abc", limit: 24, offset: 0 });
  expect(calls[0].sql).toContain("serve_count");
  expect(calls[0].sql).toContain("FROM live_assets WHERE collection_id = ?");
  expect(calls[0].args).toEqual(["col_abc", 24, 0]);
});

it("getCollectionMember requires both id and collection_id", async () => {
  const { db, calls } = fakeDb(null);
  const { assets } = makeD1Stores(db);
  expect(await assets.getCollectionMember("a1", "col_abc")).toBeNull();
  expect(calls[0].sql).toContain("WHERE id = ? AND collection_id = ?");
});

it("tombstoneAsset sets dead_at on the base table", async () => {
  const { db, calls } = fakeDb();
  const { assets } = makeD1Stores(db);
  await assets.tombstoneAsset("a1");
  expect(calls[0].sql).toContain("UPDATE assets SET dead_at = datetime('now') WHERE id = ? AND dead_at IS NULL");
});

it("tombstoneByCollection tombstones live members and returns their ids", async () => {
  const { db, calls } = fakeDb(null, [{ id: "a1" }, { id: "a2" }]);
  const { assets } = makeD1Stores(db);
  const ids = await assets.tombstoneByCollection("col_abc");
  expect(ids).toEqual(["a1", "a2"]);
  expect(calls[0].sql).toContain("UPDATE assets SET dead_at = datetime('now') WHERE collection_id = ? AND dead_at IS NULL");
  expect(calls[0].sql).toContain("RETURNING id");
});

it("bumpServeCount increments on the base table", async () => {
  const { db, calls } = fakeDb();
  const { assets } = makeD1Stores(db);
  await assets.bumpServeCount("a1");
  expect(calls[0].sql).toContain("serve_count = serve_count + 1");
  expect(calls[0].args).toEqual(["a1"]);
});

it("searchAssets adds a collection_id clause in browse and query modes when scoped", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "", limit: 5, offset: 0, collectionId: "col_abc" });
  expect(calls[0].sql).toContain("collection_id = ?");
  await assets.searchAssets({ q: "fox", limit: 5, offset: 0, collectionId: "col_abc" });
  expect(calls[1].sql).toContain("prompt LIKE ?");
  expect(calls[1].sql).toContain("collection_id = ?");
});

it("insertGenerated binds collection_id (null for global byok)", async () => {
  const { db, calls } = fakeDb();
  const { assets } = makeD1Stores(db);
  await assets.insertGenerated({ id: "g1", prompt: "p", sourceUrl: "https://x/g1.png", mime: "image/png", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai", priceUsd: 0.04, createdBy: "usr_1", collectionId: "col_abc" });
  expect(calls[0].sql).toContain("collection_id");
  expect(calls[0].args).toContain("col_abc");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/d1.test.ts`
Expected: FAIL — `collections` is not a property of `makeD1Stores(db)`; new asset methods undefined.

- [ ] **Step 4: Add the types**

In `projects/worker/src/types.ts`:

Add after the `LibraryAssetRow` line (line 8):

```ts
export interface CollectionRow {
  id: string; owner_user_id: string; name: string; theme_prompt: string;
  created_at: string; updated_at: string;
}
export interface CollectionSummary extends CollectionRow { image_count: number; total_serves: number; }
export interface CollectionImageRow extends LibraryAssetRow { serve_count: number; }
export interface CollectionStore {
  create(c: { id: string; ownerUserId: string; name: string; themePrompt: string }): Promise<void>;
  get(id: string): Promise<CollectionRow | null>;
  listByOwner(userId: string): Promise<CollectionSummary[]>;
  countByOwner(userId: string): Promise<number>;
  patch(id: string, f: { name?: string; themePrompt?: string }): Promise<void>;
  delete(id: string): Promise<void>;
}
```

Replace the `AssetStore` interface body: `searchAssets` input gains `collectionId?: string`, `insertGenerated`'s arg gains `collectionId: string | null`, and add the five new methods:

```ts
export interface AssetStore {
  getAsset(id: string): Promise<AssetRow | null>;
  searchAssets(i: { q: string; limit: number; offset: number; collectionId?: string }): Promise<LibraryAssetRow[]>;
  /** Batch lookup for the semantic-search hydration path; missing ids are simply absent (no error). */
  getAssetsByIds(ids: string[]): Promise<LibraryAssetRow[]>;
  /** Insert a BYOK-generated asset. source='byok'; the row serves from
   *  source_url until the demand-first rehost derives B2 sizes (0008). */
  insertGenerated(a: { id: string; prompt: string; sourceUrl: string; mime: string; width: number | null; height: number | null; modelUsed: string; provider: string; priceUsd: number; createdBy: string; collectionId: string | null }): Promise<void>;
  /** Owner-facing management list: public shape + serve_count. */
  listByCollection(i: { collectionId: string; limit: number; offset: number }): Promise<CollectionImageRow[]>;
  /** Live membership check for owner image deletion. */
  getCollectionMember(assetId: string, collectionId: string): Promise<AssetRow | null>;
  tombstoneAsset(id: string): Promise<void>;
  /** Tombstones all live members; returns their ids for vector cleanup. */
  tombstoneByCollection(collectionId: string): Promise<string[]>;
  /** Fire-and-forget serve counter (hit/approximate generation returns only). */
  bumpServeCount(id: string): Promise<void>;
}
```

Add `collections: CollectionStore;` to the `Services` interface (after `byok: ByokStore;`).

- [ ] **Step 5: Implement in d1.ts**

In `projects/worker/src/d1.ts`:

Update the return type and destructure of `makeD1Stores` to include `collections: CollectionStore` (import `CollectionStore`, `CollectionRow`, `CollectionSummary`, `CollectionImageRow` from `./types`).

Replace `searchAssets` and `insertGenerated` in the `assets` store and add the new methods:

```ts
    async searchAssets({ q, limit, offset, collectionId }) {
      const tokens = q.split(/\s+/).filter(Boolean);
      const where: string[] = tokens.map(() => "prompt LIKE ? ESCAPE '\\'");
      const args: unknown[] = tokens.map((t) => `%${escapeLike(t)}%`);
      if (collectionId) { where.push("collection_id = ?"); args.push(collectionId); }
      const cond = where.length ? `WHERE ${where.join(" AND ")} ` : "";
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at FROM live_assets ${cond}ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).bind(...args, limit, offset).all<LibraryAssetRow>();
      return results ?? [];
    },
```

```ts
    async insertGenerated(a) {
      // url (legacy NOT NULL) mirrors source_url; assetUrls() ignores it for
      // non-locally_cached rows and serves source_url directly.
      await db.prepare(
        `INSERT INTO assets (id, prompt, source, model_used, width, height, mime, source_url, url, locally_cached, price_usd, provider, created_by, collection_id)
         VALUES (?, ?, 'byok', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).bind(a.id, a.prompt, a.modelUsed, a.width, a.height, a.mime, a.sourceUrl, a.sourceUrl, a.priceUsd, a.provider, a.createdBy, a.collectionId).run();
    },
    async listByCollection({ collectionId, limit, offset }) {
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at, serve_count FROM live_assets WHERE collection_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).bind(collectionId, limit, offset).all<CollectionImageRow>();
      return results ?? [];
    },
    async getCollectionMember(assetId, collectionId) {
      const row = await db.prepare(
        `SELECT ${ASSET_COLS} FROM live_assets WHERE id = ? AND collection_id = ?`
      ).bind(assetId, collectionId).first<AssetRow>();
      return row ?? null;
    },
    // Tombstones write to the base table: live_assets is a view and the
    // dead_at IS NULL guard makes both calls idempotent.
    async tombstoneAsset(id) {
      await db.prepare("UPDATE assets SET dead_at = datetime('now') WHERE id = ? AND dead_at IS NULL").bind(id).run();
    },
    async tombstoneByCollection(collectionId) {
      const { results } = await db.prepare(
        "UPDATE assets SET dead_at = datetime('now') WHERE collection_id = ? AND dead_at IS NULL RETURNING id"
      ).bind(collectionId).all<{ id: string }>();
      return (results ?? []).map((r) => r.id);
    },
    async bumpServeCount(id) {
      await db.prepare("UPDATE assets SET serve_count = serve_count + 1 WHERE id = ?").bind(id).run();
    },
```

Add the collections store before the final `return`:

```ts
  const collections: CollectionStore = {
    async create({ id, ownerUserId, name, themePrompt }) {
      await db.prepare(
        "INSERT INTO collections (id, owner_user_id, name, theme_prompt) VALUES (?, ?, ?, ?)"
      ).bind(id, ownerUserId, name, themePrompt).run();
    },
    async get(id) {
      const row = await db.prepare(
        "SELECT id, owner_user_id, name, theme_prompt, created_at, updated_at FROM collections WHERE id = ?"
      ).bind(id).first<CollectionRow>();
      return row ?? null;
    },
    async listByOwner(userId) {
      // Aggregates come from live_assets so tombstoned images drop out of both counts.
      const { results } = await db.prepare(
        `SELECT c.id, c.owner_user_id, c.name, c.theme_prompt, c.created_at, c.updated_at,
                COUNT(a.id) AS image_count, COALESCE(SUM(a.serve_count), 0) AS total_serves
         FROM collections c LEFT JOIN live_assets a ON a.collection_id = c.id
         WHERE c.owner_user_id = ?
         GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`
      ).bind(userId).all<CollectionSummary>();
      return results ?? [];
    },
    async countByOwner(userId) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM collections WHERE owner_user_id = ?").bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
    async patch(id, f) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const args: unknown[] = [];
      if (f.name != null) { sets.push("name = ?"); args.push(f.name); }
      if (f.themePrompt != null) { sets.push("theme_prompt = ?"); args.push(f.themePrompt); }
      await db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
    },
    async delete(id) {
      await db.prepare("DELETE FROM collections WHERE id = ?").bind(id).run();
    },
  };
```

Return `{ assets, queries, keys, users, sessions, loginTokens, byok, collections }`.

- [ ] **Step 6: Wire buildServices and fakes**

In `projects/worker/src/index.ts` `buildServices`, destructure and pass through `collections`:

```ts
  const { assets, queries, keys, users, sessions, loginTokens, byok, collections } = makeD1Stores(env.DB);
```
and add `collections` to the returned `Services` object (after `byok`).

In `projects/worker/test/fakes.ts`: import `CollectionRow` type; inside `fakeServices` add backing state and the fake stores (insert alongside the other maps at the top, and the store after `byok`):

```ts
  const collectionRows = new Map<string, CollectionRow>();
  const serveCounts = new Map<string, number>();
  const tombstoned: string[] = [];
```

Extend the fake `assets` store (replace `insertGenerated` and add the new methods):

```ts
      insertGenerated: async (a) => {
        generatedInserts.push(a);
        assets.set(a.id, {
          id: a.id, prompt: a.prompt, source: "byok", source_id: null, model_used: a.modelUsed,
          width: a.width, height: a.height, mime: a.mime, source_url: a.sourceUrl, locally_cached: 0,
        });
      },
      listByCollection: async ({ collectionId, limit, offset }) =>
        libraryRows.filter((r: any) => r.collection_id === collectionId).slice(offset, offset + limit).map((r: any) => ({ ...r, serve_count: serveCounts.get(r.id) ?? 0 })),
      getCollectionMember: async (assetId, collectionId) => {
        const r: any = assets.get(assetId);
        return r && r.collection_id === collectionId && !tombstoned.includes(assetId) ? r : null;
      },
      tombstoneAsset: async (id) => { tombstoned.push(id); assets.delete(id); },
      tombstoneByCollection: async (collectionId) => {
        const ids = [...assets.values()].filter((r: any) => r.collection_id === collectionId).map((r) => r.id);
        for (const id of ids) { tombstoned.push(id); assets.delete(id); }
        return ids;
      },
      bumpServeCount: async (id) => { serveCounts.set(id, (serveCounts.get(id) ?? 0) + 1); },
```

Add the `collections` fake store to `base` (after `byok`):

```ts
    collections: {
      create: async ({ id, ownerUserId, name, themePrompt }) => {
        collectionRows.set(id, { id, owner_user_id: ownerUserId, name, theme_prompt: themePrompt, created_at: "x", updated_at: "x" });
      },
      get: async (id) => collectionRows.get(id) ?? null,
      listByOwner: async (userId) => [...collectionRows.values()].filter((c) => c.owner_user_id === userId).map((c) => ({ ...c, image_count: 0, total_serves: 0 })),
      countByOwner: async (userId) => [...collectionRows.values()].filter((c) => c.owner_user_id === userId).length,
      patch: async (id, f) => { const c = collectionRows.get(id); if (!c) return; if (f.name != null) c.name = f.name; if (f.themePrompt != null) c.theme_prompt = f.themePrompt; },
      delete: async (id) => { collectionRows.delete(id); },
    },
```

Expose internals for assertions (with the other `(base as any)._x` lines):

```ts
  (base as any)._collectionRows = collectionRows;
  (base as any)._serveCounts = serveCounts;
  (base as any)._tombstoned = tombstoned;
```

- [ ] **Step 7: Run the full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS (new d1 tests pass; nothing existing breaks — `collectionId` is optional on `searchAssets`, `insertGenerated` callers are updated in Task 5/6 but `byok.ts` still compiles because vitest doesn't typecheck; if `byok.ts` shows a TS error in your editor, ignore until Task 6).

Note: `byok.ts`'s `insertGenerated` call now misses `collectionId` per the type. To keep the tree type-clean within this task, add `collectionId: null,` to the `insertGenerated` call in `projects/worker/src/byok.ts` (line ~86, after `createdBy: i.userId,`) now:

```ts
      createdBy: i.userId, // audit trail (AUP/takedown); never selected on public reads
      collectionId: null,
```
(Task 6 replaces this with the real value.)

- [ ] **Step 8: Commit**

```bash
git add projects/worker/migrations/0015_collections.sql projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/src/index.ts projects/worker/src/byok.ts projects/worker/test/fakes.ts projects/worker/test/d1.test.ts
git commit -m "feat(collections): migration 0015 + D1 collection store, serve_count, tombstone helpers"
```

---

### Task 2: Vectorize namespace support + deleteByIds + new index binding

**Files:**
- Modify: `projects/worker/src/vectorize.ts`
- Modify: `projects/worker/src/types.ts` (VectorizeStore, Env)
- Modify: `projects/worker/src/index.ts` (buildServices)
- Modify: `projects/worker/wrangler.toml`
- Modify: `projects/worker/test/fakes.ts`
- Modify: `DEPLOY.md`
- Test: `projects/worker/test/vectorize.test.ts`

**Interfaces:**
- Consumes: `shardFor(id, n)` from `./shard`; `makeVectorize(bindings)` (existing).
- Produces:
  - `makeVectorize(bindings: VectorizeIndex[], coll?: VectorizeIndex): VectorizeStore`
  - `VectorizeStore.queryNamespace(vector: number[], namespace: string, topK: number): Promise<Match[]>`
  - `VectorizeStore.upsertNamespace(id: string, vector: number[], namespace: string): Promise<void>`
  - `VectorizeStore.deleteByIds(ids: string[]): Promise<void>` — routes each id to its fnv1a32 shard AND the collections index
  - `Env.VECTORIZE_COLL?: VectorizeIndex`

- [ ] **Step 1: Write failing tests**

Append to `projects/worker/test/vectorize.test.ts`:

```ts
it("queryNamespace queries only the collections index with the namespace option", async () => {
  const calls: any[] = [];
  const shard = { query: async () => ({ matches: [] }), upsert: async () => {}, deleteByIds: async () => {} };
  const coll: any = {
    query: async (v: number[], opts: any) => { calls.push(opts); return { matches: [{ id: "a1", score: 0.9 }] }; },
    upsert: async () => {}, deleteByIds: async () => {},
  };
  const store = makeVectorize([shard, shard, shard] as any, coll);
  const got = await store.queryNamespace([0.1], "col_abc", 3);
  expect(got).toEqual([{ id: "a1", score: 0.9 }]);
  expect(calls[0]).toEqual({ topK: 3, namespace: "col_abc" });
});

it("queryNamespace returns [] when no collections binding (local dev degrade)", async () => {
  const shard = { query: async () => ({ matches: [] }), upsert: async () => {} };
  const store = makeVectorize([shard, shard, shard] as any);
  expect(await store.queryNamespace([0.1], "col_abc", 3)).toEqual([]);
});

it("upsertNamespace writes the vector with a namespace to the collections index", async () => {
  const written: any[] = [];
  const shard = { query: async () => ({ matches: [] }), upsert: async () => {} };
  const coll: any = { upsert: async (vs: any[]) => written.push(...vs) };
  const store = makeVectorize([shard, shard, shard] as any, coll);
  await store.upsertNamespace("a1", [0.1, 0.2], "col_abc");
  expect(written).toEqual([{ id: "a1", values: [0.1, 0.2], namespace: "col_abc" }]);
});

it("deleteByIds routes each id to its fnv1a32 shard and always the collections index", async () => {
  const perShard: string[][] = [[], [], []];
  const collDeleted: string[] = [];
  const mkShard = (i: number): any => ({ query: async () => ({ matches: [] }), upsert: async () => {}, deleteByIds: async (ids: string[]) => perShard[i].push(...ids) });
  const coll: any = { deleteByIds: async (ids: string[]) => collDeleted.push(...ids) };
  const store = makeVectorize([mkShard(0), mkShard(1), mkShard(2)], coll);
  // contract.json shard_fixtures: demo-1 -> 0, demo-3 -> 1, pd12m-8492731 -> 2
  await store.deleteByIds(["demo-1", "demo-3", "pd12m-8492731"]);
  expect(perShard[0]).toEqual(["demo-1"]);
  expect(perShard[1]).toEqual(["demo-3"]);
  expect(perShard[2]).toEqual(["pd12m-8492731"]);
  expect(collDeleted.sort()).toEqual(["demo-1", "demo-3", "pd12m-8492731"]);
});

it("deleteByIds with no ids is a no-op", async () => {
  const store = makeVectorize([{ query: async () => ({ matches: [] }), upsert: async () => {} }] as any);
  await store.deleteByIds([]); // must not throw
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/vectorize.test.ts`
Expected: FAIL — `queryNamespace`/`upsertNamespace`/`deleteByIds` do not exist.

- [ ] **Step 3: Extend the VectorizeStore type**

In `projects/worker/src/types.ts` replace the `VectorizeStore` interface:

```ts
export interface VectorizeStore {
  query(vector: number[], topK: number): Promise<Match[]>;
  /** Shard-routed write (fnv1a32(id) % shards) — BYOK in-request ingest. */
  upsert(id: string, vector: number[]): Promise<void>;
  /** Collection-scoped query against the namespaced collections index only.
   *  Returns [] when the index is not bound (local dev). */
  queryNamespace(vector: number[], namespace: string, topK: number): Promise<Match[]>;
  /** Best-effort second write for collection assets (namespace = collection id). */
  upsertNamespace(id: string, vector: number[], namespace: string): Promise<void>;
  /** Best-effort removal from the owning shard AND the collections index.
   *  D1 tombstones are the source of truth; orphans are tolerated. */
  deleteByIds(ids: string[]): Promise<void>;
}
```

And in `Env`, after `VECTORIZE_2: VectorizeIndex;`:

```ts
  /** Namespaced collections index (namespace = collection id); optional so local dev degrades. */
  VECTORIZE_COLL?: VectorizeIndex;
```

- [ ] **Step 4: Implement in vectorize.ts**

Replace `projects/worker/src/vectorize.ts`'s `makeVectorize` with:

```ts
export function makeVectorize(bindings: VectorizeIndex[], coll?: VectorizeIndex): VectorizeStore {
  return {
    async query(vector, topK) {
      const results = await Promise.all(bindings.map((b) => b.query(vector, { topK })));
      const best = new Map<string, number>();
      for (const r of results) {
        for (const m of r.matches ?? []) {
          const prev = best.get(m.id);
          if (prev == null || m.score > prev) best.set(m.id, m.score);
        }
      }
      return [...best.entries()]
        .map(([id, score]): Match => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    async upsert(id, vector) {
      await bindings[shardFor(id, bindings.length)].upsert([{ id, values: vector }]);
    },
    async queryNamespace(vector, namespace, topK) {
      if (!coll) return []; // unbound in local dev: scoped search degrades to a miss
      const r = await coll.query(vector, { topK, namespace });
      return (r.matches ?? []).map((m): Match => ({ id: m.id, score: m.score }));
    },
    async upsertNamespace(id, vector, namespace) {
      if (!coll) return;
      await coll.upsert([{ id, values: vector, namespace }]);
    },
    async deleteByIds(ids) {
      if (ids.length === 0) return;
      const byShard = new Map<number, string[]>();
      for (const id of ids) {
        const s = shardFor(id, bindings.length);
        byShard.set(s, [...(byShard.get(s) ?? []), id]);
      }
      await Promise.all([
        ...[...byShard.entries()].map(([s, list]) => bindings[s].deleteByIds(list)),
        ...(coll ? [coll.deleteByIds(ids)] : []),
      ]);
    },
  };
}
```

- [ ] **Step 5: Wire binding + fakes**

`projects/worker/src/index.ts` `buildServices`:

```ts
    vectorize: makeVectorize([env.VECTORIZE_0, env.VECTORIZE_1, env.VECTORIZE_2], env.VECTORIZE_COLL),
```

`projects/worker/wrangler.toml` — after the `VECTORIZE_2` block:

```toml
# Vectorize — namespaced collections index (namespace = collection id). Dual-
# written alongside the shards for collection assets; scoped queries hit only
# this index. Create with:
#   npx wrangler vectorize create wagmiphotos-coll --dimensions=768 --metric=cosine
[[vectorize]]
binding = "VECTORIZE_COLL"
index_name = "wagmiphotos-coll"
```

`projects/worker/test/fakes.ts` — extend the fake `vectorize` store:

```ts
    vectorize: {
      query: async () => matches,
      upsert: async (id: string, vector: number[]) => { upserted.push({ id, vector }); },
      queryNamespace: async (_v: number[], namespace: string) => nsMatches.filter((m) => m.ns === namespace).map((m) => ({ id: m.id, score: m.score })),
      upsertNamespace: async (id: string, vector: number[], namespace: string) => { nsUpserted.push({ id, vector, namespace }); },
      deleteByIds: async (ids: string[]) => { vectorDeletes.push(...ids); },
    },
```
with backing arrays declared alongside `matches`/`upserted`:

```ts
  const nsMatches: { id: string; score: number; ns: string }[] = [];
  const nsUpserted: { id: string; vector: number[]; namespace: string }[] = [];
  const vectorDeletes: string[] = [];
```
and exposed:

```ts
  (base as any)._nsMatches = nsMatches;
  (base as any)._nsUpserted = nsUpserted;
  (base as any)._vectorDeletes = vectorDeletes;
```

`DEPLOY.md` — add to the BYOK/runbook area a "Collections" step (after the BYOK section):

```markdown
## Collections (namespaced vector index)

1. **Vectorize index:** `npx wrangler vectorize create wagmiphotos-coll --dimensions=768 --metric=cosine`
   (the `VECTORIZE_COLL` binding in wrangler.toml expects this exact name; same dims/metric as the BGE shards).
2. **Migration:** `npx wrangler d1 migrations apply wagmiphotos --remote` (0015: collections table + assets.collection_id/serve_count + live_assets recreation).
3. No backfill/GMI changes — the backfill never generates for collections (scoped requests write no demand rows).
```

- [ ] **Step 6: Run the full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/src/vectorize.ts projects/worker/src/types.ts projects/worker/src/index.ts projects/worker/wrangler.toml projects/worker/test/vectorize.test.ts projects/worker/test/fakes.ts DEPLOY.md
git commit -m "feat(collections): namespaced VECTORIZE_COLL index — queryNamespace/upsertNamespace/deleteByIds"
```

---

### Task 3: collections.ts core helpers (id, combined prompt, validation)

**Files:**
- Create: `projects/worker/src/collections.ts`
- Test: `projects/worker/test/collections.test.ts`

**Interfaces:**
- Produces (used by Tasks 4–7):
  - `MAX_COLLECTIONS_PER_USER = 20`, `MAX_COLLECTION_NAME_LEN = 80`, `MAX_THEME_PROMPT_LEN = 500`
  - `newCollectionId(): string` — `col_` + 20 base32 chars
  - `combinedPrompt(prompt: string, theme: string): string` — `"p, theme"`, or `p` unchanged when theme is blank
  - `validateCollectionFields(body: any, partial: boolean): { name?: string; themePrompt?: string } | { error: string }`
  - `collectionView(c: CollectionRow | CollectionSummary): object` — public JSON shape

- [ ] **Step 1: Write failing tests**

Create `projects/worker/test/collections.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/collections.test.ts`
Expected: FAIL — module `../src/collections` does not exist.

- [ ] **Step 3: Implement collections.ts**

Create `projects/worker/src/collections.ts`:

```ts
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
    ...("image_count" in c ? { image_count: c.image_count, total_serves: c.total_serves } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npx vitest run test/collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/collections.ts projects/worker/test/collections.test.ts
git commit -m "feat(collections): core helpers — id generation, combined prompt, validation, public view"
```

---

### Task 4: Management routes — create / list / patch

**Files:**
- Create: `projects/worker/src/collections-routes.ts`
- Modify: `projects/worker/src/index.ts` (routing)
- Test: `projects/worker/test/collections-routes.test.ts`

**Interfaces:**
- Consumes: `resolveApiPrincipal(request, env, { sessions, keys })` (session or bearer → `{ userId }`), `s.byok.get(userId)` (`enabled` flag), Task 1 `CollectionStore`, Task 3 helpers.
- Produces:
  - `handleCreateCollection(request: Request, env: Env, s: Services): Promise<Response>`
  - `handleListCollections(request: Request, env: Env, s: Services): Promise<Response>`
  - `handlePatchCollection(id: string, request: Request, env: Env, s: Services): Promise<Response>`
  - Response body: `{ collection: collectionView(...) }` (create/patch), `{ collections: [...] }` (list).

- [ ] **Step 1: Write failing tests**

Create `projects/worker/test/collections-routes.test.ts`:

```ts
import { it, expect } from "vitest";
import { handleCreateCollection, handleListCollections, handlePatchCollection } from "../src/collections-routes";
import { fakeServices } from "./fakes";
import { sha256Hex } from "../src/auth";

const env: any = { DEV_MODE: undefined };

// Session-authenticated request: fake sessions.resolve returns the user for any cookie.
function sessionReq(userId: string, method = "GET", body?: any): { req: Request; s: any } {
  const s: any = fakeServices();
  s.sessions.resolve = async () => ({ user_id: userId });
  const req = new Request("https://x/v1/collections", {
    method,
    headers: { Cookie: "wagmi_session=tok", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { req, s };
}

async function giveByok(s: any, userId: string, enabled = true) {
  await s.byok.put({ userId, provider: "openai", keyCiphertext: "ct", keyLast4: "1234", monthlyCap: 50, enabled });
}

it("create: 401 without auth", async () => {
  const s = fakeServices();
  const req = new Request("https://x/v1/collections", { method: "POST", body: JSON.stringify({ name: "n" }) });
  expect((await handleCreateCollection(req, env, s)).status).toBe(401);
});

it("create: 403 byok required when no enabled key", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Retro" });
  const res = await handleCreateCollection(req, env, s);
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("byok required");
});

it("create: 403 when byok key exists but is disabled", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Retro" });
  await giveByok(s, "usr_1", false);
  expect((await handleCreateCollection(req, env, s)).status).toBe(403);
});

it("create: happy path returns the collection and persists it", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: " Retro posters ", theme_prompt: "retro poster style" });
  await giveByok(s, "usr_1");
  const res = await handleCreateCollection(req, env, s);
  expect(res.status).toBe(200);
  const { collection } = await res.json();
  expect(collection.id).toMatch(/^col_[a-z2-7]{20}$/);
  expect(collection.name).toBe("Retro posters");
  expect(collection.theme_prompt).toBe("retro poster style");
  expect((s as any)._collectionRows.get(collection.id).owner_user_id).toBe("usr_1");
});

it("create: 422 on bad name, 409 at the 20-collection cap", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "" });
  await giveByok(s, "usr_1");
  expect((await handleCreateCollection(req, env, s)).status).toBe(422);
  for (let i = 0; i < 20; i++) {
    await s.collections.create({ id: `col_${String(i).padStart(20, "x")}`, ownerUserId: "usr_1", name: `c${i}`, themePrompt: "" });
  }
  const { req: req2 } = sessionReq("usr_1", "POST", { name: "one more" });
  const res = await handleCreateCollection(req2, env, s);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("collection limit reached");
});

it("list: returns only own collections with aggregates", async () => {
  const { req, s } = sessionReq("usr_1");
  await s.collections.create({ id: "col_mine".padEnd(24, "a"), ownerUserId: "usr_1", name: "mine", themePrompt: "" });
  await s.collections.create({ id: "col_them".padEnd(24, "b"), ownerUserId: "usr_2", name: "theirs", themePrompt: "" });
  const res = await handleListCollections(req, env, s);
  const { collections } = await res.json();
  expect(collections.length).toBe(1);
  expect(collections[0].name).toBe("mine");
  expect(collections[0].image_count).toBe(0);
});

it("patch: owner can edit theme; non-owner gets 404; no fields 422", async () => {
  const { req, s } = sessionReq("usr_1", "PATCH", { theme_prompt: "new theme" });
  await s.collections.create({ id: "col_x".padEnd(24, "x"), ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  const id = "col_x".padEnd(24, "x");
  const res = await handlePatchCollection(id, req, env, s);
  expect(res.status).toBe(200);
  expect((await res.json()).collection.theme_prompt).toBe("new theme");

  const { req: req2, s: s2 } = sessionReq("usr_2", "PATCH", { theme_prompt: "hijack" });
  await s2.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  expect((await handlePatchCollection(id, req2, env, s2)).status).toBe(404);

  const { req: req3, s: s3 } = sessionReq("usr_1", "PATCH", {});
  await s3.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  expect((await handlePatchCollection(id, req3, env, s3)).status).toBe(422);
});

it("bearer key auth works for create (paid keys manage collections too)", async () => {
  const s: any = fakeServices();
  await giveByok(s, "usr_9");
  s.keys.getKeyOwner = async (h: string) => (h === await sha256Hex("sc-k") ? "usr_9" : null);
  const req = new Request("https://x/v1/collections", {
    method: "POST", headers: { Authorization: "Bearer sc-k", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "via key" }),
  });
  expect((await handleCreateCollection(req, env, s)).status).toBe(200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/collections-routes.test.ts`
Expected: FAIL — module `../src/collections-routes` does not exist.

- [ ] **Step 3: Implement the three handlers**

Create `projects/worker/src/collections-routes.ts`:

```ts
import type { Env, Services } from "./types";
import { resolveApiPrincipal } from "./session";
import {
  newCollectionId, validateCollectionFields, collectionView, MAX_COLLECTIONS_PER_USER,
} from "./collections";

// Management surface: session or bearer key (resolveApiPrincipal), owner-scoped.
// Non-owner requests on a specific collection answer 404 (not 403): the id is
// a capability for *searching*; whether someone else owns it is not disclosed.

async function auth(request: Request, env: Env, s: Services): Promise<string | null> {
  const p = await resolveApiPrincipal(request, env, s);
  return p ? p.userId : null;
}

export async function handleCreateCollection(request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  // Valid BYOK = an enabled key row: creation is pointless without a generation path.
  const byok = await s.byok.get(userId);
  if (!byok || !byok.enabled) return Response.json({ error: "byok required", detail: "add an enabled provider key first" }, { status: 403 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const fields = validateCollectionFields(body, false);
  if ("error" in fields) return Response.json({ error: fields.error }, { status: 422 });

  if ((await s.collections.countByOwner(userId)) >= MAX_COLLECTIONS_PER_USER) {
    return Response.json({ error: "collection limit reached", limit: MAX_COLLECTIONS_PER_USER }, { status: 409 });
  }
  const id = newCollectionId();
  await s.collections.create({ id, ownerUserId: userId, name: fields.name!, themePrompt: fields.themePrompt ?? "" });
  const row = await s.collections.get(id);
  return Response.json({ collection: collectionView(row!) });
}

export async function handleListCollections(request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const rows = await s.collections.listByOwner(userId);
  return Response.json({ collections: rows.map(collectionView) });
}

export async function handlePatchCollection(id: string, request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const fields = validateCollectionFields(body, true);
  if ("error" in fields) return Response.json({ error: fields.error }, { status: 422 });

  await s.collections.patch(id, fields);
  const updated = await s.collections.get(id);
  return Response.json({ collection: collectionView(updated!) });
}
```

- [ ] **Step 4: Register routes**

In `projects/worker/src/index.ts`, import the handlers:

```ts
import { handleCreateCollection, handleListCollections, handlePatchCollection } from "./collections-routes";
```

Add after the `/v1/byok` block (before `libraryCfg`):

```ts
      if (url.pathname === "/v1/collections") {
        if (request.method === "POST") return await handleCreateCollection(request, env, services);
        if (request.method === "GET") return await handleListCollections(request, env, services);
      }
      const collOne = url.pathname.match(/^\/v1\/collections\/([^/]+)$/);
      if (collOne && request.method === "PATCH") {
        let id: string;
        try { id = decodeURIComponent(collOne[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handlePatchCollection(id, request, env, services);
      }
```

- [ ] **Step 5: Run the full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/collections-routes.ts projects/worker/src/index.ts projects/worker/test/collections-routes.test.ts
git commit -m "feat(collections): create/list/patch management routes (BYOK-gated, owner-scoped)"
```

---

### Task 5: Owner image list + image delete + collection delete

**Files:**
- Modify: `projects/worker/src/collections-routes.ts`
- Modify: `projects/worker/src/index.ts` (routing)
- Test: `projects/worker/test/collections-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `listByCollection`/`getCollectionMember`/`tombstoneAsset`/`tombstoneByCollection`, Task 2 `deleteByIds`, `assetUrls(asset, baseUrl)` from `./asset-urls`.
- Produces:
  - `handleListCollectionImages(id: string, url: URL, request: Request, env: Env, s: Services, cfg: { assetBaseUrl?: string }): Promise<Response>` → `{ images: [{...publicAsset, serve_count}], has_more }`
  - `handleDeleteCollectionImage(collectionId: string, assetId: string, request: Request, env: Env, s: Services): Promise<Response>` → `{ status: "ok" }`
  - `handleDeleteCollection(id: string, request: Request, env: Env, s: Services): Promise<Response>` → `{ status: "ok", images_deleted: number }`

- [ ] **Step 1: Write failing tests**

Append to `projects/worker/test/collections-routes.test.ts` (reuses `sessionReq` from Task 4):

```ts
import { handleListCollectionImages, handleDeleteCollectionImage, handleDeleteCollection } from "../src/collections-routes";

function seedCollectionAsset(s: any, id: string, collectionId: string) {
  const row = {
    id, prompt: `p-${id}`, source: "byok", source_id: null, model_used: "gpt-image-1",
    width: 1024, height: 1024, mime: "image/png", source_url: `https://x/${id}.png`,
    locally_cached: 0, created_at: "2026-07-09", collection_id: collectionId,
  };
  (s as any)._assets.set(id, row);
  (s as any)._libraryRows.push(row);
}

it("images list: owner sees serve_count; non-owner 404", async () => {
  const { req, s } = sessionReq("usr_1");
  const id = "col_i".padEnd(24, "i");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  await s.assets.bumpServeCount("a1");
  const res = await handleListCollectionImages(id, new URL("https://x/v1/collections/x/images"), req, env, s, {});
  expect(res.status).toBe(200);
  const { images } = await res.json();
  expect(images[0].id).toBe("a1");
  expect(images[0].serve_count).toBe(1);

  const { req: req2, s: s2 } = sessionReq("usr_2");
  await s2.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  expect((await handleListCollectionImages(id, new URL("https://x/v1/collections/x/images"), req2, env, s2, {})).status).toBe(404);
});

it("image delete: tombstones + deletes vectors; 404 for non-member", async () => {
  const { req, s } = sessionReq("usr_1", "DELETE");
  const id = "col_d".padEnd(24, "d");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  const res = await handleDeleteCollectionImage(id, "a1", req, env, s);
  expect(res.status).toBe(200);
  expect((s as any)._tombstoned).toContain("a1");
  expect((s as any)._vectorDeletes).toContain("a1");
  // not a member anymore -> 404 on repeat
  expect((await handleDeleteCollectionImage(id, "a1", req, env, s)).status).toBe(404);
});

it("collection delete: tombstones all live members, deletes vectors, removes the row", async () => {
  const { req, s } = sessionReq("usr_1", "DELETE");
  const id = "col_z".padEnd(24, "z");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  seedCollectionAsset(s, "a2", id);
  const res = await handleDeleteCollection(id, req, env, s);
  expect(res.status).toBe(200);
  expect((await res.json()).images_deleted).toBe(2);
  expect((s as any)._tombstoned.sort()).toEqual(["a1", "a2"]);
  expect((s as any)._vectorDeletes.sort()).toEqual(["a1", "a2"]);
  expect((s as any)._collectionRows.has(id)).toBe(false);
});

it("collection delete: vector-delete failure still deletes the collection (best-effort)", async () => {
  const { req, s } = sessionReq("usr_1", "DELETE");
  const id = "col_f".padEnd(24, "f");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  s.vectorize.deleteByIds = async () => { throw new Error("vectorize down"); };
  const res = await handleDeleteCollection(id, req, env, s);
  expect(res.status).toBe(200);
  expect((s as any)._collectionRows.has(id)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/collections-routes.test.ts`
Expected: FAIL — the three new handlers are not exported.

- [ ] **Step 3: Implement the handlers**

Append to `projects/worker/src/collections-routes.ts` (add `assetUrls` import: `import { assetUrls } from "./asset-urls";`):

```ts
// Chunk best-effort vector deletes so one huge collection can't blow a single
// Vectorize mutation; failures log and move on (D1 tombstone is authoritative).
const VECTOR_DELETE_CHUNK = 100;
async function deleteVectors(s: Services, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTOR_DELETE_CHUNK) {
    try { await s.vectorize.deleteByIds(ids.slice(i, i + VECTOR_DELETE_CHUNK)); }
    catch (e) { console.error("collection vector delete failed", e); }
  }
}

export async function handleListCollectionImages(
  id: string, url: URL, request: Request, env: Env, s: Services, cfg: { assetBaseUrl?: string }
): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });

  // Same limit/offset semantics and caps as /v1/library.
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
    if (!Number.isInteger(n) || n < 0) return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    offset = n;
  }
  const rows = await s.assets.listByCollection({ collectionId: id, limit: limit + 1, offset });
  const page = rows.slice(0, limit);
  const images = page.map((r) => {
    const u = assetUrls(r, cfg.assetBaseUrl);
    return {
      id: r.id, prompt: r.prompt, thumb_url: u.thumb_url, medium_url: u.medium_url,
      url: u.url, width: r.width, height: r.height, mime: r.mime,
      model_used: r.model_used, source: r.source, created_at: r.created_at,
      original_url: u.original_url,
      serve_count: r.serve_count, // owner-only stat; never on public library shapes
    };
  });
  return Response.json({ images, has_more: rows.length > limit });
}

export async function handleDeleteCollectionImage(
  collectionId: string, assetId: string, request: Request, env: Env, s: Services
): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(collectionId);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  const member = await s.assets.getCollectionMember(assetId, collectionId);
  if (!member) return Response.json({ error: "not found" }, { status: 404 });
  await s.assets.tombstoneAsset(assetId); // authoritative
  await deleteVectors(s, [assetId]);      // best-effort hygiene
  return Response.json({ status: "ok" });
}

export async function handleDeleteCollection(id: string, request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  // Order: tombstone (authoritative) -> vectors (best-effort) -> row delete.
  // A crash mid-way leaves tombstoned assets + a live row; re-running is idempotent.
  const ids = await s.assets.tombstoneByCollection(id);
  await deleteVectors(s, ids);
  await s.collections.delete(id);
  return Response.json({ status: "ok", images_deleted: ids.length });
}
```

- [ ] **Step 4: Register routes**

In `projects/worker/src/index.ts`, extend the import:

```ts
import {
  handleCreateCollection, handleListCollections, handlePatchCollection,
  handleListCollectionImages, handleDeleteCollectionImage, handleDeleteCollection,
} from "./collections-routes";
```

Replace the `collOne` block from Task 4 with (note: `libraryCfg` must move ABOVE this block since the images route needs `assetBaseUrl` — move the existing `const libraryCfg = ...` line up, before the `/v1/collections` routes):

```ts
      const collImages = url.pathname.match(/^\/v1\/collections\/([^/]+)\/images$/);
      if (collImages && request.method === "GET") {
        let id: string;
        try { id = decodeURIComponent(collImages[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleListCollectionImages(id, url, request, env, services, libraryCfg);
      }
      const collImageDel = url.pathname.match(/^\/v1\/collections\/([^/]+)\/images\/([^/]+)$/);
      if (collImageDel && request.method === "DELETE") {
        let cid: string, aid: string;
        try { cid = decodeURIComponent(collImageDel[1]); aid = decodeURIComponent(collImageDel[2]); }
        catch { return new Response("Not found", { status: 404 }); }
        return await handleDeleteCollectionImage(cid, aid, request, env, services);
      }
      const collOne = url.pathname.match(/^\/v1\/collections\/([^/]+)$/);
      if (collOne && (request.method === "PATCH" || request.method === "DELETE")) {
        let id: string;
        try { id = decodeURIComponent(collOne[1]); } catch { return new Response("Not found", { status: 404 }); }
        if (request.method === "PATCH") return await handlePatchCollection(id, request, env, services);
        return await handleDeleteCollection(id, request, env, services);
      }
```

- [ ] **Step 5: Run the full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/collections-routes.ts projects/worker/src/index.ts projects/worker/test/collections-routes.test.ts
git commit -m "feat(collections): owner image list + image/collection delete with tombstones and vector cleanup"
```

---

### Task 6: Scoped generation — handler.ts + byok.ts

**Files:**
- Modify: `projects/worker/src/handler.ts`
- Modify: `projects/worker/src/byok.ts`
- Test: `projects/worker/test/handler.test.ts`, `projects/worker/test/byok.test.ts`

**Interfaces:**
- Consumes: `combinedPrompt`, Task 1/2 store methods, existing `runByok`/`tryByokGenerate` orchestration.
- Produces:
  - `GenBody` gains `collection?: string`.
  - `tryByokGenerate` input gains `collectionId?: string | null`; on success it calls `s.assets.insertGenerated({... collectionId})` and best-effort `s.vectorize.upsertNamespace(id, vec, collectionId)`.
  - Scoped responses carry `shared_cache.collection: <id>`; scoped `generation_queued` is always `false`; scoped requests never call `recordQuery`.
  - `hit`/`approximate` returns call `s.assets.bumpServeCount(asset.id)` best-effort (scoped AND global).

- [ ] **Step 1: Write failing byok tests**

Append to `projects/worker/test/byok.test.ts`. The file already defines these helpers at the top — use them exactly: `seededServices()` (fakeServices + an enabled openai key for user `"u1"`) and `cfg(over)` (a working `ByokCfg` whose `uuid` is pinned to `"gen-1"`):

```ts
it("scoped generation: insertGenerated carries collectionId and the namespace gets a best-effort upsert", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate(
    { userId: "u1", prompt: "a cat, watercolor style", vec: [0.1], collectionId: "col_abc" }, s, cfg()
  );
  expect(out.kind).toBe("generated");
  expect((s as any)._generatedInserts[0].collectionId).toBe("col_abc");
  expect((s as any)._upserted).toEqual([{ id: "gen-1", vector: [0.1] }]);          // main shard write unchanged
  expect((s as any)._nsUpserted).toEqual([{ id: "gen-1", vector: [0.1], namespace: "col_abc" }]);
});

it("scoped generation: namespace upsert failure does not fail the request", async () => {
  const s = await seededServices();
  s.vectorize.upsertNamespace = async () => { throw new Error("vectorize down"); };
  const out = await tryByokGenerate(
    { userId: "u1", prompt: "p", vec: [0.1], collectionId: "col_abc" }, s, cfg()
  );
  expect(out.kind).toBe("generated");
});

it("global generation passes collectionId null and skips the namespace write", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "p", vec: [0.1] }, s, cfg());
  expect(out.kind).toBe("generated");
  expect((s as any)._generatedInserts[0].collectionId).toBeNull();
  expect((s as any)._nsUpserted).toEqual([]);
});
```

- [ ] **Step 2: Write failing handler tests**

Append to `projects/worker/test/handler.test.ts`. The file already imports `handleGenerate`/`fakeServices` and defines `const cfg = { floorSimMax: 0.35, floorSimMin: 0.18, imagePrice: 0.055, now: () => 1000, assetBaseUrl: BASE }` — reuse that `cfg`. With the default tolerance 0.15 the floor is ≈0.325, so scores ≥0.35 are hits and scores like 0.2 are approximate:

```ts
function withCollection(s: any, id = "col_abc", owner = "usr_owner", theme = "watercolor style") {
  s._collectionRows.set(id, { id, owner_user_id: owner, name: "n", theme_prompt: theme, created_at: "x", updated_at: "x" });
  return id;
}

it("scoped: 404 unknown collection", async () => {
  const s: any = fakeServices();
  const res = await handleGenerate({ prompt: "a cat", collection: "col_nope" }, s, cfg);
  expect(res.status).toBe(404);
});

it("scoped: 422 when combined prompt exceeds MAX_PROMPT_LEN", async () => {
  const s: any = fakeServices();
  const id = withCollection(s, "col_abc", "usr_owner", "t".repeat(400));
  const res = await handleGenerate({ prompt: "p".repeat(1700), collection: id }, s, cfg);
  expect(res.status).toBe(422);
});

it("scoped: embeds the combined prompt and queries only the namespace", async () => {
  const s: any = fakeServices();
  const embedCalls: string[] = [];
  s.embedder.textEmbed = async (p: string) => { embedCalls.push(p); return [0.1]; };
  let namespaceQueried: string | null = null;
  s.vectorize.queryNamespace = async (_v: any, ns: string) => { namespaceQueried = ns; return []; };
  s.vectorize.query = async () => { throw new Error("global index must not be queried for scoped requests"); };
  const id = withCollection(s);
  await handleGenerate({ prompt: "a cat", collection: id, generate_on_miss: false }, s, cfg);
  expect(embedCalls).toEqual(["a cat, watercolor style"]);
  expect(namespaceQueried).toBe(id);
});

it("scoped hit: serves the collection asset, echoes collection, bumps serve_count, never records demand", async () => {
  const s: any = fakeServices();
  const id = withCollection(s);
  s._assets.set("a1", { id: "a1", prompt: "a cat, watercolor style", source: "byok", source_id: null, model_used: "gpt-image-1", width: 1024, height: 1024, mime: "image/png", source_url: "https://x/a1.png", locally_cached: 0 });
  s._nsMatches.push({ id: "a1", score: 0.95, ns: id });
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.shared_cache.result).toBe("hit");
  expect(body.shared_cache.collection).toBe(id);
  expect(s._serveCounts.get("a1")).toBe(1);
  expect(s._recorded).toEqual([]); // backfill exclusion: no queries write, ever
});

it("scoped approximate (non-owner): closest match served, no generation, no demand row, serve_count bumped", async () => {
  const s: any = fakeServices();
  const id = withCollection(s, "col_abc", "usr_owner");
  s._assets.set("a1", { id: "a1", prompt: "a dog, watercolor style", source: "byok", source_id: null, model_used: "gpt-image-1", width: 1024, height: 1024, mime: "image/png", source_url: "https://x/a1.png", locally_cached: 0 });
  s._nsMatches.push({ id: "a1", score: 0.2, ns: id }); // below the ≈0.325 floor -> approximate
  await s.byok.put({ userId: "usr_caller", provider: "openai", keyCiphertext: "ct", keyLast4: "1234", monthlyCap: 50, enabled: true }); // caller has their OWN byok
  const byokCtx = { userId: "usr_caller", cfg: { kek: "k", bucket: { put: async () => {} }, publicUrlBase: "https://pub", now: () => 123 } };
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg, byokCtx as any);
  const body = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.generation_queued).toBe(false);
  expect(body.shared_cache.byok).toBeUndefined(); // non-owner: byok never consulted
  expect(s._generatedInserts).toEqual([]);        // caller's own key must NOT generate into someone else's collection
  expect(s._recorded).toEqual([]);
  expect(s._serveCounts.get("a1")).toBe(1);
});

it("scoped empty pool (non-owner or no byok): 202 pending, generation_queued false, no demand row", async () => {
  const s: any = fakeServices();
  const id = withCollection(s);
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg);
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body.shared_cache.result).toBe("pending");
  expect(body.shared_cache.generation_queued).toBe(false);
  expect(body.shared_cache.collection).toBe(id);
  expect(s._recorded).toEqual([]);
});

it("global path: hit bumps serve_count; generated does not", async () => {
  const s: any = fakeServices();
  s._assets.set("g1", { id: "g1", prompt: "p", source: "pd12m", source_id: null, model_used: "m", width: 1, height: 1, mime: "image/jpeg", source_url: "https://x/g1.jpg", locally_cached: 0 });
  s._matches.push({ id: "g1", score: 0.99 });
  await handleGenerate({ prompt: "p" }, s, cfg);
  expect(s._serveCounts.get("g1")).toBe(1);
});

it("global path unchanged: misses still record demand", async () => {
  const s: any = fakeServices();
  const res = await handleGenerate({ prompt: "novel prompt" }, s, cfg);
  expect(res.status).toBe(202);
  expect(s._recorded.length).toBe(1);
  expect(s._recorded[0].generate).toBe(true);
});

it("scoped: 422 on non-string collection", async () => {
  const s: any = fakeServices();
  const res = await handleGenerate({ prompt: "p", collection: 7 as any }, s, cfg);
  expect(res.status).toBe(422);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/handler.test.ts test/byok.test.ts`
Expected: FAIL — no `collection` handling, no `collectionId` on tryByokGenerate, no serve bumps.

- [ ] **Step 4: Implement byok.ts changes**

In `projects/worker/src/byok.ts`:

`tryByokGenerate` input type gains the field:

```ts
export async function tryByokGenerate(
  i: { userId: string; prompt: string; vec: number[]; collectionId?: string | null }, s: Services, cfg: ByokCfg
): Promise<ByokOutcome> {
```

In the `insertGenerated` call, replace `collectionId: null,` (Task 1 stopgap) with:

```ts
      collectionId: i.collectionId ?? null,
```

After the existing main-shard best-effort upsert (`try { await s.vectorize.upsert(id, i.vec); } ...`), add:

```ts
  if (i.collectionId) {
    // Second, namespace-scoped write so scoped search can find it. Best-effort:
    // a failure leaves the image globally findable but scoped-invisible until re-generated demand re-lands it.
    try { await s.vectorize.upsertNamespace(id, i.vec, i.collectionId); } catch (e) { console.error("byok namespace upsert failed", e); }
  }
```

- [ ] **Step 5: Implement handler.ts changes**

In `projects/worker/src/handler.ts`:

Imports:

```ts
import { combinedPrompt } from "./collections";
import type { CollectionRow } from "./types";
```

`GenBody` gains the field:

```ts
export interface GenBody { prompt: string; n?: number; size?: string; cache_tolerance?: number; generate_on_miss?: boolean; collection?: string; }
```

Add a serve-count helper above `handleGenerate`:

```ts
// Best-effort owner-facing stat: only hit/approximate returns count ("matched
// and returned"), never the initial generated response and never library reads.
async function bumpServed(s: Services, assetId: string): Promise<void> {
  try { await s.assets.bumpServeCount(assetId); } catch (e) { console.error("bumpServeCount failed", e); }
}
```

Inside `handleGenerate`, after the `cache_tolerance` validation block, add collection resolution:

```ts
  if (body.collection != null && (typeof body.collection !== "string" || body.collection === "")) {
    return Response.json({ error: "collection must be a non-empty string" }, { status: 422 });
  }
  let coll: CollectionRow | null = null;
  if (body.collection) {
    coll = await s.collections.get(body.collection);
    if (!coll) return Response.json({ error: "unknown collection" }, { status: 404 });
    if (combinedPrompt(body.prompt, coll.theme_prompt).length > MAX_PROMPT_LEN) {
      return Response.json({ error: `prompt plus collection theme must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
    }
  }
```

Replace the block from `const prompt = body.prompt;` through `const matches = await s.vectorize.query(vec, QUERY_TOP_K);` with the scoped variants (the theme-combined prompt is what gets embedded, matched, moderated, generated, and stored — the spec's embedding-honesty rule; `prompt` from here on IS the effective prompt):

```ts
  const prompt = coll ? combinedPrompt(body.prompt, coll.theme_prompt) : body.prompt;
  const tol = body.cache_tolerance ?? DEFAULT_CACHE_TOLERANCE;
  const generateOnMiss = body.generate_on_miss ?? true;
  const floor = similarityFloor(tol, cfg.floorSimMax, cfg.floorSimMin);
  const normalized = normalizePrompt(prompt);

  // Scoped generation is owner-only: a non-owner's own BYOK key must never
  // spend into (or theme-pollute) someone else's collection.
  const gen = coll && byok && byok.userId !== coll.owner_user_id ? null : byok;

  const vec = await s.embedder.textEmbed(prompt);
  const matches = coll
    ? await s.vectorize.queryNamespace(vec, coll.id, QUERY_TOP_K)
    : await s.vectorize.query(vec, QUERY_TOP_K);
```

Thread the scoped context through the two miss paths and the serve path:

1. Every `runByok(byok, ...)` call becomes `runByok(gen, ...)` and passes the collection: change `runByok`'s signature to accept it and forward to `tryByokGenerate`:

```ts
async function runByok(
  byok: { userId: string; cfg: ByokCfg } | null | undefined,
  generateOnMiss: boolean, prompt: string, vec: number[], s: Services,
  collectionId: string | null
): Promise<{ outcome: ByokOutcome | null; fallbackStatus: string | null }> {
  if (!byok || !generateOnMiss) return { outcome: null, fallbackStatus: null };
  let outcome: ByokOutcome;
  try {
    outcome = await tryByokGenerate({ userId: byok.userId, prompt, vec, collectionId }, s, byok.cfg);
  } catch (e) {
    console.error("byok path failed", e);
    return { outcome: null, fallbackStatus: "provider_error" };
  }
  if (outcome.kind === "generated" || outcome.kind === "content_policy") return { outcome, fallbackStatus: null };
  if (outcome.kind === "cap_reached" || outcome.kind === "provider_error") return { outcome: null, fallbackStatus: outcome.kind };
  return { outcome: null, fallbackStatus: null }; // skipped
}
```

Call sites: `await runByok(gen, generateOnMiss, prompt, vec, s, coll?.id ?? null)`.

2. `generatedResponse` gains the echo — change its signature to `generatedResponse(outcome, cfg, collectionId: string | null)` and inside `shared_cache` add:

```ts
      ...(collectionId ? { collection: collectionId } : {}),
```
Call sites pass `coll?.id ?? null`.

3. Guard every `recordQuery` with the scoped check. In the empty-pool branch:

```ts
    if (b.outcome?.kind === "generated") {
      if (!coll) {
        try {
          await s.queries.recordQuery({ normalized, original: prompt, assetId: b.outcome.asset.id, similarity: 1, built: true, generate: false });
        } catch (e) { console.error("recordQuery failed", e); }
      }
      return generatedResponse(b.outcome, cfg, coll?.id ?? null);
    }
    let generationQueued = false;
    if (!coll) {
      try {
        generationQueued = await s.queries.recordQuery({
          normalized, original: prompt, assetId: null, similarity: 0, built: false, generate: generateOnMiss,
        });
      } catch (e) { console.error("recordQuery failed", e); }
    }
```
and add to the 202 body's `shared_cache`:

```ts
          ...(coll ? { collection: coll.id, generation_queued: false } : { generation_queued: generationQueued }),
```
(replacing the existing `generation_queued: generationQueued` field there).

Apply the same `if (!coll)` guard to the below-floor `recordQuery` (inside `if (!isHit)`) and the final `recordQuery` before the serve response.

4. Before the final `const u = assetUrls(asset, cfg.assetBaseUrl);` add the serve bump:

```ts
  await bumpServed(s, asset.id);
```

5. In the final response's `shared_cache`, replace `...(isHit ? {} : { generation_queued: generationQueued }),` with:

```ts
      ...(coll ? { collection: coll.id } : {}),
      ...(isHit ? {} : { generation_queued: coll ? false : generationQueued }),
```

- [ ] **Step 6: Run the full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS — including all pre-existing handler tests (global behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add projects/worker/src/handler.ts projects/worker/src/byok.ts projects/worker/test/handler.test.ts projects/worker/test/byok.test.ts
git commit -m "feat(collections): scoped generation — namespace search, owner-only BYOK, serve counts, no demand rows"
```

---

### Task 7: Scoped /v1/library

**Files:**
- Modify: `projects/worker/src/library.ts`
- Test: `projects/worker/test/library.test.ts`

**Interfaces:**
- Consumes: `s.collections.get`, `s.vectorize.queryNamespace`, `combinedPrompt`, `searchAssets({..., collectionId})`.
- Produces: `GET /v1/library?collection=col_...` — public scoped browse/search (any authed caller; index.ts route/auth is untouched).

- [ ] **Step 1: Write failing tests**

Append to `projects/worker/test/library.test.ts` (reuse its existing `fakeServices` + `cfg = { floorSimMin: 0.75 }` idioms):

```ts
it("library scoped: 404 unknown collection", async () => {
  const s: any = fakeServices();
  const res = await handleLibrarySearch(new URL("https://x/v1/library?collection=col_nope"), s, { floorSimMin: 0.75 });
  expect(res.status).toBe(404);
});

it("library scoped semantic: embeds query+theme and hits only the namespace", async () => {
  const s: any = fakeServices();
  s._collectionRows.set("col_abc", { id: "col_abc", owner_user_id: "u", name: "n", theme_prompt: "watercolor style", created_at: "x", updated_at: "x" });
  const embeds: string[] = [];
  s.embedder.textEmbed = async (p: string) => { embeds.push(p); return [0.1]; };
  s._assets.set("a1", { id: "a1", prompt: "a cat, watercolor style", source: "byok", source_id: null, model_used: "m", width: 1, height: 1, mime: "image/png", source_url: "https://x/a1.png", locally_cached: 0, created_at: "x" });
  s._nsMatches.push({ id: "a1", score: 0.9, ns: "col_abc" });
  s.vectorize.query = async () => { throw new Error("global shards must not serve scoped library searches"); };
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat&collection=col_abc"), s, { floorSimMin: 0.75 });
  const { images } = await res.json();
  expect(embeds).toEqual(["cat, watercolor style"]);
  expect(images.map((i: any) => i.id)).toEqual(["a1"]);
  expect(images[0].serve_count).toBeUndefined(); // public shape: no owner stats
});

it("library scoped browse/fallback: LIKE path filters by collection_id", async () => {
  const s: any = fakeServices();
  s._collectionRows.set("col_abc", { id: "col_abc", owner_user_id: "u", name: "n", theme_prompt: "", created_at: "x", updated_at: "x" });
  const res = await handleLibrarySearch(new URL("https://x/v1/library?collection=col_abc"), s, { floorSimMin: 0.75 });
  expect(res.status).toBe(200);
  expect(s._searchCalls[0].collectionId).toBe("col_abc");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/library.test.ts`
Expected: FAIL — no `collection` param handling.

- [ ] **Step 3: Implement**

In `projects/worker/src/library.ts` add the import:

```ts
import { combinedPrompt } from "./collections";
import type { CollectionRow } from "./types";
```

In `handleLibrarySearch`, after the `offset` parsing block, resolve the collection:

```ts
  let coll: CollectionRow | null = null;
  const collectionId = url.searchParams.get("collection");
  if (collectionId) {
    coll = await s.collections.get(collectionId);
    if (!coll) return Response.json({ error: "unknown collection" }, { status: 404 });
  }
```

Change the semantic branch to scope by namespace:

```ts
  if (q) {
    try {
      const vec = await s.embedder.textEmbed(coll ? combinedPrompt(q, coll.theme_prompt) : q);
      const matches = coll
        ? await s.vectorize.queryNamespace(vec, coll.id, SEARCH_TOP_K)
        : await s.vectorize.query(vec, SEARCH_TOP_K);
      ...
```
(the rest of the branch is unchanged).

Change the browse/fallback call to pass the filter:

```ts
  const rows = await s.assets.searchAssets({ q, limit: limit + 1, offset, ...(coll ? { collectionId: coll.id } : {}) });
```

- [ ] **Step 4: Run the full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/library.ts projects/worker/test/library.test.ts
git commit -m "feat(collections): collection param on /v1/library (namespace semantic + LIKE fallback)"
```

---

### Task 8: SPA — account Collections card

**Files:**
- Modify: `projects/worker/public/index.html`

No unit tests (the SPA has none); verify via Task 10's manual pass. Keep the existing inline-style idiom of the file.

- [ ] **Step 1: Add the card markup**

In `projects/worker/public/index.html`, directly after the BYOK card `</div>` (the `<!-- BYOK Card -->` block ending near line 3114, before `<!-- Credentials Card -->`), insert:

```html
      <!-- Collections Card -->
      <div class="glass-card">
        <h2 class="card-title">Collections</h2>
        <p style="font-size: 0.8125rem; color: var(--muted); margin-bottom: 14px;">
          Themed sets of images generated with your own key. The theme prompt is appended to every image you generate into the collection, and anyone who knows the collection ID can scope API searches to it (<code style="font-family: var(--font-mono);">"collection": "col_…"</code>). Images also join the shared library.
        </p>
        <div id="collections-body" style="font-size: 0.9375rem; color: var(--muted);">Loading…</div>
      </div>
```

- [ ] **Step 2: Add the JS**

Next to `renderByok()` (same `<script>` region, ~line 4397), add:

```js
    let myCollections = [];
    const expandedCollections = new Set();

    async function loadCollections() {
      const el = document.getElementById('collections-body');
      if (!el) return;
      if (!currentUser) { el.textContent = 'Log in to manage collections.'; return; }
      try {
        const r = await fetch('/v1/collections', { credentials: 'same-origin' });
        if (r.status === 401) { el.textContent = 'Log in to manage collections.'; return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        myCollections = (await r.json()).collections;
        renderCollections();
      } catch {
        el.textContent = 'Could not load collections.';
      }
    }

    function renderCollections() {
      const el = document.getElementById('collections-body');
      if (!el) return;
      const canCreate = !!(currentByok && currentByok.enabled);
      const createForm = canCreate ? `
        <div class="form-group" style="margin-top:14px;">
          <label>New collection</label>
          <input id="coll-name" placeholder="Name (e.g. Retro posters)" maxlength="80" style="height:40px;">
          <label style="margin-top:10px;">Theme prompt (appended to every generation)</label>
          <textarea id="coll-theme" maxlength="500" placeholder="e.g. retro travel poster style, muted palette" style="min-height:60px;"></textarea>
          <button class="btn btn-primary" style="height:40px;width:auto;padding:0 18px;margin-top:12px;" onclick="createCollection(this)">Create collection</button>
        </div>`
        : `<div style="font-size:0.8125rem;margin-top:10px;">Add an enabled provider key above to create collections.</div>`;
      const rows = myCollections.map((c) => `
        <div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <b style="color:var(--ink);">${escapeHtml(c.name)}</b>
              <span style="font-family:var(--font-mono);font-size:0.75rem;"> ${escapeHtml(c.id)}</span>
              <div style="font-size:0.8125rem;">${c.image_count} image${c.image_count === 1 ? '' : 's'} · returned ${c.total_serves}× · theme: ${c.theme_prompt ? escapeHtml(c.theme_prompt) : '<i>none</i>'}</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn" style="height:32px;width:auto;padding:0 10px;font-size:0.8125rem;" onclick="editCollectionTheme('${c.id}')">Edit theme</button>
              <button class="btn" style="height:32px;width:auto;padding:0 10px;font-size:0.8125rem;" onclick="toggleCollectionImages('${c.id}')">${expandedCollections.has(c.id) ? 'Hide images' : 'View images'}</button>
              <button class="btn" style="height:32px;width:auto;padding:0 10px;font-size:0.8125rem;color:var(--danger);" onclick="deleteCollection('${c.id}', this)">Delete</button>
            </div>
          </div>
          <div id="coll-images-${c.id}" style="margin-top:10px;"></div>
        </div>`).join('');
      el.innerHTML = (myCollections.length ? rows : '<div style="font-size:0.8125rem;">No collections yet.</div>') + createForm;
      for (const id of expandedCollections) loadCollectionImages(id);
    }

    async function createCollection(btn) {
      const name = document.getElementById('coll-name')?.value?.trim();
      const theme = document.getElementById('coll-theme')?.value?.trim() || '';
      if (!name) { showToast('Give the collection a name', 'error'); return; }
      if (btn) btn.disabled = true;
      try {
        const r = await fetch('/v1/collections', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, theme_prompt: theme }),
        });
        const data = await r.json();
        if (r.status === 403) { showToast('An enabled provider key is required', 'error'); return; }
        if (r.status === 409) { showToast('Collection limit reached (20)', 'error'); return; }
        if (!r.ok) { showToast(data.error || 'Could not create the collection', 'error'); return; }
        showToast('Collection created', 'success');
        await loadCollections();
      } catch { showToast('Could not create the collection', 'error'); }
      finally { if (btn) btn.disabled = false; }
    }

    async function editCollectionTheme(id) {
      const c = myCollections.find((x) => x.id === id);
      const theme = prompt('Theme prompt (appended to every future generation in this collection):', c ? c.theme_prompt : '');
      if (theme == null) return;
      try {
        const r = await fetch('/v1/collections/' + encodeURIComponent(id), {
          method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme_prompt: theme }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        showToast('Theme updated — applies to future generations', 'success');
        await loadCollections();
      } catch { showToast('Could not update the theme', 'error'); }
    }

    async function deleteCollection(id, btn) {
      if (!confirm('Delete this collection AND all its images? They are removed from the shared library too. This cannot be undone.')) return;
      if (btn) btn.disabled = true;
      try {
        const r = await fetch('/v1/collections/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        expandedCollections.delete(id);
        showToast('Collection deleted', 'success');
        await loadCollections();
      } catch { showToast('Could not delete the collection', 'error'); if (btn) btn.disabled = false; }
    }

    function toggleCollectionImages(id) {
      if (expandedCollections.has(id)) expandedCollections.delete(id); else expandedCollections.add(id);
      renderCollections();
    }

    async function loadCollectionImages(id) {
      const el = document.getElementById('coll-images-' + id);
      if (!el) return;
      el.innerHTML = '<span style="font-size:0.75rem;">Loading images…</span>';
      try {
        const r = await fetch('/v1/collections/' + encodeURIComponent(id) + '/images?limit=60', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const { images } = await r.json();
        if (!images.length) { el.innerHTML = '<span style="font-size:0.75rem;">No images yet — generate into this collection from the playground or API.</span>'; return; }
        el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;">' + images.map((img) => `
          <div style="position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;">
            <img src="${img.thumb_url}" alt="${escapeHtml(img.prompt)}" title="${escapeHtml(img.prompt)}" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;">
            <span style="position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.65);color:#fff;font-size:0.6875rem;padding:1px 6px;border-radius:9px;" title="Times returned by the API">${img.serve_count}×</span>
            <button style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.65);color:#fff;border:0;border-radius:9px;font-size:0.6875rem;padding:1px 7px;cursor:pointer;" title="Delete image" onclick="deleteCollectionImage('${id}', '${img.id}')">✕</button>
          </div>`).join('') + '</div>';
      } catch { el.innerHTML = '<span style="font-size:0.75rem;">Could not load images.</span>'; }
    }

    async function deleteCollectionImage(collId, assetId) {
      if (!confirm('Delete this image? It is removed from the shared library too.')) return;
      try {
        const r = await fetch('/v1/collections/' + encodeURIComponent(collId) + '/images/' + encodeURIComponent(assetId), { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        showToast('Image deleted', 'success');
        await loadCollections();
      } catch { showToast('Could not delete the image', 'error'); }
    }
```

- [ ] **Step 3: Wire into the account route**

In the `'#/account'` route's `onShow` (~line 3892), after `renderByok();` add:

```js
        loadCollections();
```

- [ ] **Step 4: Smoke-check the page parses**

Run: `cd projects/worker && npx vitest run test/router.test.ts`
Expected: PASS (router tests fetch the SPA shell; a broken `<script>` would surface in Task 10's manual pass — also open the file and confirm balanced tags around your insertions).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(collections): account-page collections card — create/edit/delete, image grid with serve counts"
```

---

### Task 9: SPA — playground picker + docs parameter row

**Files:**
- Modify: `projects/worker/public/index.html`

- [ ] **Step 1: Add the picker markup**

In the playground controls (after the `gen-on-miss` form-group closing `</div>`, before the `btn-submit` button, ~line 2966):

```html
            <div class="form-group" id="coll-picker-group" hidden>
              <label for="coll-select">Collection</label>
              <select id="coll-select" style="height: 40px;">
                <option value="">Library (everything)</option>
              </select>
              <span style="font-size: 0.75rem; color: var(--muted); margin-top: 6px; display: block;">
                Scope matching to one of your collections; its theme prompt is appended when a new image is generated.
              </span>
            </div>
```

- [ ] **Step 2: Populate it and send the parameter**

Add near `loadCollections()` (it reuses `myCollections`):

```js
    async function loadPlaygroundCollections() {
      const group = document.getElementById('coll-picker-group');
      const sel = document.getElementById('coll-select');
      if (!group || !sel) return;
      if (!currentUser) { group.hidden = true; return; }
      try {
        const r = await fetch('/v1/collections', { credentials: 'same-origin' });
        if (!r.ok) { group.hidden = true; return; }
        const { collections } = await r.json();
        myCollections = collections;
        if (!collections.length) { group.hidden = true; return; }
        const prev = sel.value;
        sel.innerHTML = '<option value="">Library (everything)</option>' +
          collections.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
        group.hidden = false;
      } catch { group.hidden = true; }
    }
```

Wire it into the playground route (change `'#/playground': { view: 'view-playground', link: 'nav-playground' },` to):

```js
      '#/playground': { view: 'view-playground', link: 'nav-playground', onShow: loadPlaygroundCollections },
```

In `generateImage()` (~line 4633), read the picker and include the field:

```js
        const genOnMiss = document.getElementById('gen-on-miss').checked;
        const collSel = document.getElementById('coll-select');
        const collId = collSel && !document.getElementById('coll-picker-group').hidden ? collSel.value : '';

        const response = await fetch('/v1/images/generations', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptVal,
            cache_tolerance: tolVal,
            generate_on_miss: genOnMiss,
            ...(collId ? { collection: collId } : {})
          })
        });
```

- [ ] **Step 3: Show the collection in the result details**

In the result `details-grid` (~line 3012), add a fifth item:

```html
                <div class="details-item" id="val-collection-item" style="display:none;">
                  <span class="details-label">Collection</span>
                  <span class="details-val" id="val-collection">-</span>
                </div>
```

In the response-handling section of `generateImage()` (where `val-model`/`val-provider` get set — search for `val-model`), add:

```js
        const collItem = document.getElementById('val-collection-item');
        if (collItem) {
          const collName = sc.collection ? ((myCollections.find((c) => c.id === sc.collection) || {}).name || sc.collection) : null;
          collItem.style.display = collName ? '' : 'none';
          const collVal = document.getElementById('val-collection');
          if (collVal) collVal.textContent = collName || '-';
        }
```

- [ ] **Step 4: Docs table row**

In the docs request-body table (~line 3248, after the `generate_on_miss` row `</tr>`), add:

```html
                  <tr>
                    <td>collection</td><td>string</td><td>—</td>
                    <td>Scope matching to a collection by ID (<code>col_…</code>). The collection's theme prompt is appended before matching, and on a miss only the collection owner's BYOK key generates — misses never queue background generation. Official SDKs pass it via <code>extra_body</code>.</td>
                  </tr>
```

- [ ] **Step 5: Run the suite + commit**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS.

```bash
git add projects/worker/public/index.html
git commit -m "feat(collections): playground collection picker + docs parameter row"
```

---

### Task 10: End-to-end verification (local)

**Files:** none (verification only; fix-forward anything found and commit fixes).

- [ ] **Step 1: Full suite**

Run: `cd projects/worker && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 2: Apply migrations locally and boot**

Follow the `running-locally` skill (`.claude/skills/running-locally`): ensure `.dev.vars` exists with `DEV_MODE=true`, then:

```bash
cd projects/worker
npx wrangler d1 migrations apply wagmiphotos --local
npx wrangler dev --local
```
Expected: 0015 applies cleanly; worker boots.

- [ ] **Step 3: Manual API pass (dev lane, curl)**

Known offline caveats: Vectorize/Workers AI are unavailable → scoped semantic search returns misses/LIKE fallback, and BYOK generation can't run. Verify the D1-backed surfaces:

```bash
# Dev-lane collection create is blocked without BYOK (expect 403 byok required):
curl -s -X POST http://localhost:8787/v1/collections -H 'Content-Type: application/json' -d '{"name":"Test"}'
# Unknown collection on generations (expect 404 unknown collection):
curl -s -X POST http://localhost:8787/v1/images/generations -H 'Content-Type: application/json' -d '{"prompt":"a cat","collection":"col_nope"}'
# Unknown collection on library (expect 404):
curl -s 'http://localhost:8787/v1/library?collection=col_nope'
```
Expected outputs as annotated.

- [ ] **Step 4: Manual SPA pass**

Open `http://localhost:8787/#/account` after a dev magic-link login (link is console-logged): the Collections card renders the BYOK-required hint. Open `#/playground`: no picker shown (no collections). Open `#/docs`: `collection` row present.

- [ ] **Step 5: Commit any fixes; hand off**

```bash
git status   # confirm clean or commit fixes with test coverage
```

Deployment (operator, from DEPLOY.md "Collections" section added in Task 2): create the `wagmiphotos-coll` index, apply migration 0015 `--remote`, deploy the worker.
