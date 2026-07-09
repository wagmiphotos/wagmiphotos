# Collections — design

**Date:** 2026-07-09
**Status:** approved (brainstorm w/ Joris)

## Summary

A **collection** is an owner-managed, themed grouping of BYOK-generated images that
live in the shared global library. Users with an enabled BYOK key create
collections; generating with `collection` set scopes the cache search to that
collection and, on a miss, generates through the owner's BYOK key with the
collection's **theme prompt** appended. Anyone who knows a collection's id can
scope searches to it. The backfill never generates for collections. A new
per-asset **serve count** ("how many times was this image matched and
returned") is tracked and shown to collection owners.

### Decisions (from brainstorm)

- **Visibility:** collection images also join the global library — a collection
  is a filter/tag, not an isolation boundary.
- **Search access:** anyone with the collection id can scope searches
  (`/v1/images/generations`, `/v1/library`). The unguessable id is the
  capability.
- **Write access:** only the owner generates into / deletes from a collection.
  Non-owner scoped misses never generate anything.
- **Collection delete removes its images** (tombstones + vector deletes), not
  just the grouping.
- **Serve count events:** `/v1/images/generations` returning the asset as
  `hit` **or** `approximate`. The initial `generated` response does not count;
  library browse/search never counts.
- **Vector scoping approach:** new namespaced Vectorize index, dual-write
  (Approach A). Rejected: metadata filters on the live shards (prod surgery,
  3-shard fan-out per scoped query), D1 post-filtering (false misses once a
  collection can't crack the global top-100).

## 1. Data model (migration 0015)

```sql
CREATE TABLE collections (
  id            TEXT PRIMARY KEY,            -- 'col_' + 20 random base32 chars
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,               -- display name, <= 80 chars, editable
  theme_prompt  TEXT NOT NULL DEFAULT '',    -- <= 500 chars, editable (future generations only)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_collections_owner ON collections(owner_user_id);

ALTER TABLE assets ADD COLUMN collection_id TEXT;           -- NULL = plain library asset
ALTER TABLE assets ADD COLUMN serve_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_assets_collection ON assets(collection_id) WHERE collection_id IS NOT NULL;
-- 0008's rule: recreate live_assets so SELECT * re-expands over new columns.
DROP VIEW IF EXISTS live_assets;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
```

- The collection id is unguessable and doubles as the share capability.
- `serve_count` stays **out of `ASSET_COLS`** (like `created_by`): it is never
  selected on public read paths, only by owner-facing collections endpoints.
- Cap: **20 collections per user** (constant in `config.ts`).

## 2. Vector architecture (Approach A)

One new Vectorize index **`wagmiphotos-coll`** (768-dim cosine, same config as
the BGE shards), bound as `VECTORIZE_COLL`. **Namespace = collection id.**

- **Write** (collection generation): the combined-prompt vector is upserted to
  the main shard (`fnv1a32(id) % 3`, exactly like today — keeps the image
  globally findable) **and** to `wagmiphotos-coll` under the collection's
  namespace. The namespace write is best-effort: on failure the image is still
  served and globally findable, just temporarily invisible to scoped search.
- **Scoped query:** embed `prompt + ", " + theme_prompt`, query only
  `VECTORIZE_COLL` with `{ namespace }`. Global queries are unchanged.
- **Delete:** D1 tombstone (`dead_at`) is the source of truth; then best-effort
  `deleteByIds` on the owning main shard and the collections index. Orphan
  vectors are already skipped by every read path, so a failed vector delete
  never resurrects an image.
- `VectorizeStore` grows `queryNamespace(vector, namespace, topK)`,
  `upsertNamespace(id, vector, namespace)`, and `deleteByIds(ids)` (routes
  per-id to the right shard + the collections index).
- `contract.json` untouched (worker-only concern; backfill never sees the
  index). `wrangler.toml` gains the binding; DEPLOY.md gains the index-creation
  runbook step.
- Limits headroom (Workers Paid): 50k indexes/account, 50k namespaces/index.

### Embedding honesty rule

The generated image reflects `user prompt + theme`, so the stored `prompt` and
its embedding are the **combined** string `user_prompt + ", " + theme_prompt`
(honest for global matching), and a scoped query embeds `query + ", " + theme`
so scoped comparisons stay apples-to-apples. Consequence: editing the theme
affects only future generations and future scoped queries; existing assets
keep their original combined embedding.

## 3. API surface

New `collections.ts` + `collections-routes.ts` (mirrors the byok/byok-routes
split). Management routes accept session **or** bearer key
(`resolveApiPrincipal`); all resolve to a `userId`.

| Route | Auth | Behavior |
|---|---|---|
| `POST /v1/collections` | any authed user | Requires enabled BYOK key (`403 byok required`) and the 20-cap (`409`). Body `{name, theme_prompt?}`. Returns the collection object. |
| `GET /v1/collections` | any authed user | Lists **own** collections with `image_count` and `total_serves` aggregates. |
| `PATCH /v1/collections/:id` | owner | Edit `name` / `theme_prompt` (future generations/queries only). |
| `DELETE /v1/collections/:id` | owner | Tombstones all live assets, best-effort vector deletes (both indexes), deletes the row. Idempotent on re-run. |
| `GET /v1/collections/:id/images` | owner | Paginated management list (`limit`/`offset`, same semantics/caps as `/v1/library`): public asset shape **plus** `serve_count`. |
| `DELETE /v1/collections/:id/images/:assetId` | owner | Tombstone + best-effort vector deletes. `404` if the asset isn't a live member of that collection. |

Existing endpoints, one parameter each:

- **`POST /v1/images/generations`** — optional body field `collection`
  (string id; OpenAI SDKs pass it via `extra_body`). `404 unknown collection`;
  `422` when `prompt + ", " + theme` exceeds the 2000-char cap.
- **`GET /v1/library?collection=col_...`** — any authed caller. Semantic path
  queries the collections namespace (query embedded with theme appended);
  browse/LIKE-fallback adds `AND collection_id = ?`.

BYOK management is untouched. Deleting a BYOK key does not affect existing
collections — it only stops future generation (owner then behaves like a
non-owner on scoped misses).

## 4. Scoped generation flow (`handleGenerate` with `collection`)

1. Resolve the collection row (`404` if missing). Validate combined length.
2. Embed `prompt + ", " + theme` — one embed call, reused for search and (if
   generated) the asset upsert.
3. Query the collections namespace only. Best live match >= floor → **hit**:
   same response shape plus `shared_cache.collection` = the id; serve_count++.
4. Below floor / empty pool, caller **is owner** with working BYOK →
   `tryByokGenerate` with the **combined prompt** (denylist + moderation run on
   the combined string; provider receives it; asset row records
   `collection_id` + `created_by`; R2 key stays under `byok/`). Dual vector
   upsert. Response `result: "generated"` + `shared_cache.collection`.
5. Below floor and no generation possible (non-owner, BYOK
   disabled/cap/error, or `generate_on_miss: false`): closest collection match
   as `approximate` (serve_count++ on it, or `202 pending` when the collection
   is empty), `generation_queued: false` always, existing `byok.status` field
   explains why when the caller is the owner.
6. **`queries` is never written for scoped requests.** No demand rows = the
   backfill can never generate for a collection, and themed prompts don't
   distort global demand ranking. This is the whole backfill-exclusion
   mechanism; zero Python changes.

Global (unscoped) requests are unchanged except the fire-and-forget
`serve_count` increment on `hit`/`approximate`.

## 5. Playground & account UI (single-file SPA)

- **Account page — Collections section** (below the BYOK card): create form
  (name + theme prompt); list of own collections (name, theme, image_count,
  total_serves) with rename / edit-theme / delete (confirm states images are
  deleted too). Expanding a collection loads its image grid from
  `GET /v1/collections/:id/images`; each thumb shows a serve-count badge and a
  delete button. Renders a "BYOK key required" hint linking to the BYOK card
  when no enabled key exists.
- **Playground — collection picker:** dropdown ("Library" default) populated
  from `GET /v1/collections` for logged-in users with >= 1 collection.
  Selection adds `collection` to the POST body; result card shows the
  collection. Copy-as-code snippets show `extra_body={"collection": "col_..."}`.
- **Docs page:** request-parameter table gains the `collection` row.

## 6. Error handling & edge cases

- `404 unknown collection` on any surface for bad/deleted ids, including
  mid-request deletion races (the D1 read just misses).
- `403 byok required` (create without enabled key); `409 collection limit
  reached` (> 20); `422` for name > 80, theme > 500, combined prompt > 2000.
- Owner BYOK failure during scoped generation degrades exactly like the global
  path (`byok.status: cap_reached | provider_error`), never a 500.
- Collection delete: one
  `UPDATE assets SET dead_at = datetime('now') WHERE collection_id = ? AND dead_at IS NULL`,
  then select ids and chunked best-effort `deleteByIds` on both indexes, then
  the row delete. Crash mid-way leaves tombstoned assets + a live collection
  row; re-running is idempotent.
- `serve_count` increments and namespace upserts are fire-and-forget with
  `console.error` logging (existing best-effort idiom).

## 7. Testing

Unit tests (vitest, fake stores — same idiom as handler/byok tests):

- CRUD auth matrix (owner / non-owner / anon), BYOK-required gate, 20-cap.
- Scoped hit / approximate / generated / pending flows; theme append visible in
  embed input, provider prompt, and stored prompt.
- **No `queries` write on any scoped request** (backfill exclusion).
- Non-owner scoped miss never generates.
- serve_count increments on hit/approximate only (not generated, not library).
- Image + collection delete: tombstone + both-index deleteByIds calls.
- Scoped `/v1/library` semantic + LIKE fallback; combined-length `422`.
- Existing global-path tests pass unchanged (regression guarantee).

Manual SPA pass via the running-locally skill (offline: scoped semantic search
falls back to LIKE, as today).
