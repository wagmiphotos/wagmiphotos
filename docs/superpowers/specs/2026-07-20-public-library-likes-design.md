# Public library search + image likes — design

**Date:** 2026-07-20
**Status:** approved, pending implementation plan

## Summary

Two coupled changes to the wagmi.photos worker and its SPA:

1. **Open library search to everyone.** `GET /v1/library` currently requires
   login. Remove that gate so anonymous visitors can browse and search the
   shared library, with per-IP rate-limiting to cap bot compute. Paid surfaces
   (`/v1/images/generations`, `/v1/keys/generate`) stay gated exactly as they
   are.
2. **Add image likes.** Logged-in users can like an image. The default library
   view is sorted by most-liked; a sort toggle lets the user switch between
   "Most liked" and "Best match" (semantic relevance) once they have typed a
   query.

The two are synergistic: opening the library is what generates the traffic that
populates the like signal, which the default sort then rewards.

## Motivation / context

- The library was bulk-seeded (~511k PD12M assets). Organic engagement signal is
  effectively empty today: only ~5 assets have any `serve_count`, and
  `serve_count` is bumped only on the paid `/v1/images/generations` match path
  (`handler.ts`), never on library browse. So an existing-signal sort ("most
  viewed") would be ~511k zeros. Explicit likes are a deliberate, per-user,
  unambiguous signal we can start accruing now.
- A login wall in front of *browsing* contradicts the product's "free, open
  image library" positioning. Collections browse (`/v1/collections/browse`) is
  already public, so a public read surface is established precedent.
- The read path is safe to open: library search is a pure read. The demand write
  that drives *paid* background generation (`recordQuery`) lives only in the
  generations endpoint (`handler.ts`), not in `handleLibrarySearch`. Opening
  search hands anonymous users no lever on generation spend.

## Non-goals / scope boundaries

- No changes to the demand/generation loop, backfill worker, or BYOK. Likes are
  a display-only signal; they do **not** feed generation.
- The transient-tombstone hardening surfaced during the 2026-07-20 rehost run
  (8 healthy assets tombstoned as "retries exhausted" after transient SSL/timeout
  failures, zero real 404/410s) is a **separate follow-up**, not part of this.
- No "view count" / impression tracking. Only explicit likes.

## Data model — migration `0020_likes.sql`

```sql
CREATE TABLE likes (
  user_id    TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, asset_id)
);
CREATE INDEX idx_likes_asset ON likes(asset_id);

ALTER TABLE assets ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

-- Counter is maintained by triggers so it can never drift from the likes table.
CREATE TRIGGER likes_after_insert AFTER INSERT ON likes
BEGIN
  UPDATE assets SET like_count = like_count + 1 WHERE id = NEW.asset_id;
END;
CREATE TRIGGER likes_after_delete AFTER DELETE ON likes
BEGIN
  UPDATE assets SET like_count = like_count - 1 WHERE id = OLD.asset_id;
END;

-- Serves the default browse sort (collection_id IS NULL, like_count DESC).
CREATE INDEX idx_assets_like_browse
  ON assets(collection_id, like_count DESC, locally_cached DESC, id);
```

Design notes:

- `like_count` lives on `assets`; `live_assets` (`SELECT * FROM assets WHERE
  dead_at IS NULL`) exposes it with no view change. A tombstoned asset drops out
  of every read automatically.
- The app writes **only** `likes`, via `INSERT OR IGNORE` (like) and `DELETE`
  (unlike). The triggers fire only on an actual row change, so a repeated like or
  a spurious unlike is a no-op — idempotent and drift-free, maintained inside the
  same statement/transaction. This is deliberately preferred over app-side
  `like_count = like_count + 1`, which could double-count or drift on a partial
  failure.

## API

### Like / unlike (new)

- `POST   /v1/library/:id/like`  → `INSERT OR IGNORE INTO likes …`
- `DELETE /v1/library/:id/like`  → `DELETE FROM likes …`

Both:

- Require an authenticated principal (`resolveApiPrincipal` — session cookie or
  bearer key both yield a `userId`). **Not** paid-gated: any logged-in user may
  like for free.
- 401 for anonymous callers.
- Validate the asset exists and is live (`getAsset` → 404 if missing/dead).
- Return `{ liked: boolean, like_count: number }` reflecting the post-state.

### `GET /v1/library` (modified)

- No longer requires login (see Public access below).
- New optional `sort` query param: `match` | `liked`.
  - Default when absent: `q ? "match" : "liked"`.
- Response shape gains, on every image:
  - `like_count: number` (always).
  - `liked: boolean` — included only for authenticated callers, computed by a
    single `SELECT asset_id FROM likes WHERE user_id = ? AND asset_id IN (…page
    ids…)`. Omitted/false for anonymous callers.

### `GET /v1/library/:id/download` (modified)

- Login gate removed (open to anonymous, under the anon rate limiter). Rationale:
  once search is public the response already exposes direct CDN / `original_url`
  links, so gating the proxy only breaks the Download button for anonymous
  browsers without protecting anything.

## Ranking

Let `q` = the search query (may be empty), `sort` = resolved sort mode.

| `q` | `sort`  | Behavior |
|-----|---------|----------|
| ∅   | liked   | `SELECT … FROM live_assets WHERE collection_id IS NULL ORDER BY like_count DESC, locally_cached DESC, id ASC LIMIT ? OFFSET ?` |
| ∅   | match   | No query to match against → falls back to the `liked` browse above. |
| set | match   | Today's behavior: vector search, filter by `floorSimMin`, paginate by similarity. Unchanged. |
| set | liked   | Vector search top `SEARCH_TOP_K` (100) over the floor → fetch those rows (with `like_count`) → order by `like_count DESC, id ASC` → paginate. "Most-liked among matches." |

Cold-start / stable-shuffle notes:

- Asset IDs are random UUIDs, so `id ASC` is itself a stable pseudo-random order.
  No hash function is needed for the shuffle tiebreak, and a stable order is
  required for correct `OFFSET` pagination.
- `locally_cached DESC` floats the rehosted (fast, guaranteed-alive) images to
  the top of the default page while like counts are still sparse — a deliberate
  secondary benefit that also keeps unrehosted (potentially dead) pd12m links off
  the landing view. This term is a documented choice; it can be dropped without
  affecting correctness once likes dominate.

## Public access + rate limiting

- Drop the `resolveApiPrincipal` gate on `GET /v1/library` and
  `GET /v1/library/:id/download` in `index.ts`.
- Add two `ratelimit` namespaces in `wrangler.toml` (a CF ratelimit binding
  carries exactly one limit, hence two namespaces for two limits):

  ```toml
  [[unsafe.bindings]]
  name = "RATE_LIMITER_SEARCH"        # anonymous, keyed by CF-Connecting-IP
  type = "ratelimit"
  namespace_id = "1003"
  simple = { limit = 30, period = 60 }

  [[unsafe.bindings]]
  name = "RATE_LIMITER_SEARCH_USER"   # logged-in, keyed by userId
  type = "ratelimit"
  namespace_id = "1004"
  simple = { limit = 60, period = 60 }
  ```

- Library request flow: resolve the principal (best-effort — a failure/absence
  just means anonymous). Anonymous → limit on `RATE_LIMITER_SEARCH` keyed by
  `CF-Connecting-IP`; authenticated → limit on `RATE_LIMITER_SEARCH_USER` keyed
  by `userId`. Over-limit → 429. In dev (no binding) the limiter helper already
  returns `true`, so local runs are unaffected.
- Paid surfaces unchanged: `/v1/images/generations` (paid, writes demand) and
  `/v1/keys/generate` (paid) keep their existing auth + limiters.

## Frontend (`public/index.html`)

- **Sort toggle** near the library search box: "Most liked" (default) and "Best
  match". "Best match" is inactive until a query is present; typing a query
  selects it by default. Selection tracked in a `libSort` variable and sent as
  the `sort` param from `loadLibrary()`.
- **`libraryCard(img)`**: add a heart control showing `img.like_count`, rendered
  filled when `img.liked`. Click → `toggleLike(id)`.
- **`openImageModal(assetId)`**: same heart in the image-detail view.
- **`toggleLike(id)`**: if `!currentUser`, route through the existing login flow
  ("Log in to like"); else optimistic `POST`/`DELETE` to `…/like`, update the
  heart + count from the response, roll back on error.
- **`loadLibrary()`**: send `sort`; read `like_count` / `liked` from the
  response. Anonymous users still see hearts + counts; clicking prompts login.

## Testing (real-schema D1 harness)

- Like is idempotent: double `POST` leaves `like_count = 1` and one `likes` row.
- Unlike is floor-safe: `DELETE` of a non-existent like is a no-op; count never
  goes negative.
- Trigger integrity: `like_count` matches `COUNT(*)` from `likes` after mixed
  like/unlike sequences.
- Per-user `liked` flag correct for the authed caller and absent for anonymous.
- Sort: `sort=liked` browse ordering; `sort=liked&q=…` reorders matches by likes
  while respecting the relevance floor; `sort=match&q=…` unchanged.
- Access: anonymous `GET /v1/library` returns 200 (no 401); `POST …/like`
  returns 401 for anonymous.
- Rate limit: anonymous over the per-IP cap returns 429; logged-in uses the
  looser limiter.
- Existing floor/contract tests remain green (no floor or contract changes).

## Open choices resolved during brainstorming

- Cold-start default sort: **popularity score + stable-shuffle fallback** (not
  curated-featured, not newest-first).
- Popularity event: **explicit likes** by logged-in users (not view/impression
  counting).
- "Most liked" with an active query: **most-liked among matches** (not global).
- Anonymous rate limit: **new limiter, anon 30/min per IP, logged-in 60/min**.
