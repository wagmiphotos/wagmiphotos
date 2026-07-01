# Cloudflare Edge Cache + Python Backfill — Design Spec

**Date:** 2026-07-01
**Status:** Approved for planning
**Supersedes:** the request-path/worker portions of `docs/superpowers/specs/2026-07-01-demand-driven-cache-design.md`
(the demand-driven concepts carry over; the Python-monolith runtime does not).

## 1. Summary

SharedCache splits into two deployables around three shared Cloudflare/Backblaze stores:

- **Edge request service** — a **Cloudflare Worker** (TypeScript). Handles the OpenAI-compatible API,
  authenticates, CLIP-embeds the prompt, queries **Vectorize** for the nearest cached image, reads/writes
  **D1**, and returns an image URL. It **never generates** (no Genblaze at the edge).
- **Backfill worker** — a standalone **Python** process (`python -m sharedcache.backfill`) that runs locally
  or in a **GMI Cloud Hermes agentbox**. It polls D1 for work via the **Cloudflare REST API** and does the
  heavy lifting: demand-ranked Genblaze generation for cache-misses, and PD12M→B2 rehosting.

Shared stores: **Vectorize** (CLIP vectors), **D1** (query log + asset metadata + api keys), **Backblaze B2**
(image bytes, 3 webp sizes + manifest).

The demand-driven behaviour is unchanged in spirit: every request returns the nearest image immediately,
every query is counted, and the most-requested misses are generated first — with a re-check before each
generation so nothing is built twice.

## 2. Goals / non-goals

**Goals**
- Sub-second edge responses; no generation on the request path.
- Semantic **text→image** matching by reusing PD12M's precomputed CLIP ViT-L/14 vectors.
- Demand-ranked background generation + PD12M→B2 rehost, runnable locally or in a GMI Hermes container.
- Reuse the existing Python generation/processing/storage code as the backfill's guts.

**Non-goals**
- Synchronous / BYOK live generation at the edge (removed; all generation is the backfill's job).
- Postgres/pgvector, the FastAPI request path, and the in-process asyncio worker (all retired).
- Serving the marketing/playground UI from the Worker in v1 (optional follow-up via Workers Static Assets).

## 3. Embeddings (the linchpin)

- **One space: CLIP ViT-L/14, 768-dim, cosine.** PD12M ships precomputed CLIP ViT-L/14 **image** vectors;
  we bulk-load those into Vectorize as-is. Generated images are CLIP **image**-embedded so the index is
  uniformly image-space. Queries are CLIP **text**-embedded; CLIP aligns text and image, giving cross-modal
  text→image retrieval.
- **Two embed operations, both behind swappable env URLs:**
  - `clip_text_embed(prompt) -> float[768]` — used by the **Worker** per request and by the backfill's
    re-check. Endpoint: `CLIP_TEXT_EMBED_URL`.
  - `clip_image_embed(bytes) -> float[768]` — used by the **backfill** when inserting a generated image.
    Endpoint: `CLIP_IMAGE_EMBED_URL`.
  - Default target is the HF Inference API for `sentence-transformers/clip-ViT-L-14` (matches the existing
    `HuggingFaceClipEmbedder`); both URLs are env-config so a self-hosted GMI endpoint can be swapped in.
- **Similarity calibration (must-do):** CLIP **cross-modal** cosine similarities are low in absolute terms
  (a good text↔image match is often ≈0.25–0.35, not ≈0.8). The existing `similarity_floor` mapping
  (`sim_max=0.98, sim_min=0.70`) is calibrated for text↔text embeddings and **will reject everything** on
  CLIP scores. Recalibrate the `cache_tolerance → floor` mapping to the CLIP cross-modal range (proposed
  starting point `sim_max=0.35, sim_min=0.18`, tuned empirically against the seeded PD12M pool). This mapping
  lives in one place (`floor` logic) shared conceptually by Worker and backfill; encode the constants as
  Worker env + Python config so they can be tuned without a redeploy.

## 4. Data model

### 4.1 Vectorize index `sharedcache-clip`
- Created: `wrangler vectorize create sharedcache-clip --dimensions=768 --metric=cosine`.
- Vectors: `id` = asset UUID (== `assets.id` in D1), `values` = 768-dim CLIP vector, `metadata` = `{ "source": "pd12m" | "generated" }` (kept minimal; full detail is in D1).
- Query: `topK=1` (a few for debugging) by the query text vector → returns `{id, score}`; `score` is cosine similarity.

### 4.2 D1 schema (SQLite dialect; `worker/migrations/0001_init.sql`)
```sql
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  prompt         TEXT NOT NULL,
  source         TEXT NOT NULL,            -- 'pd12m' | 'generated'
  source_id      TEXT,
  thumb_url      TEXT,
  medium_url     TEXT,
  url            TEXT NOT NULL,            -- large; external source_url until rehosted, then B2
  model_used     TEXT,
  content_hash   TEXT,
  width          INTEGER,
  height         INTEGER,
  mime           TEXT,
  source_url     TEXT,                     -- original external URL (PD12M) to rehost from
  locally_cached INTEGER NOT NULL DEFAULT 0,  -- 0/1 (SQLite has no boolean)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS queries (
  normalized_prompt TEXT PRIMARY KEY,      -- " ".join(prompt.strip().lower().split())
  original_prompt   TEXT NOT NULL,
  count             INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'built'
  last_asset_id     TEXT,
  last_similarity   REAL,
  first_seen        TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queries_pending_count ON queries (status, count DESC);
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash   TEXT PRIMARY KEY,             -- sha256 hex of the raw sc- key
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.3 B2 layout (unchanged)
`assets/<id>/thumb.webp`, `medium.webp`, `image.webp`, `manifest.json`.

## 5. Worker request flow

`POST /v1/images/generations` (OpenAI-compatible body `{prompt, model?, n?, size?, cache_tolerance?}`):
1. **Auth:** `Authorization: Bearer <t>`. Accept if `t == env.MASTER_API_KEY`, or `sha256(t)` exists in
   `api_keys`. If `MASTER_API_KEY` unset → open (dev). `n != 1` → 422.
2. **Embed:** `clip_text_embed(prompt)` via `fetch(env.CLIP_TEXT_EMBED_URL)`.
3. **Search:** Vectorize `query(vector, topK=1)` → `{id, score}`; load the `assets` row from D1 by `id`.
4. **Log:** upsert `queries` (`count = count+1`, `last_seen`, `original_prompt`, `last_similarity`).
5. **Branch** (`floor = similarity_floor(cache_tolerance)` on the CLIP scale from §3):
   - **hit** (`score ≥ floor`, asset `locally_cached=1`): return the row's `url` (B2); `cost_saved =
     IMAGE_PRICE_USD`; set query `status='built', last_asset_id=id` if not already.
   - **hit-not-yet-rehosted** (`score ≥ floor`, `locally_cached=0`): the row's `url` still equals the external
     `source_url`, so return it as-is (user still gets an image); `sizes.thumb/medium` are null until the
     backfill rehosts to B2. `cost_saved = IMAGE_PRICE_USD`.
   - **approximate** (`score < floor`, a nearest exists): return nearest anyway; `cost_saved = IMAGE_PRICE_USD`;
     set query `status='pending'` (unless already `built`) so the backfill generates the exact image.
   - **empty** (no vector at all): `202` with `{result:"pending"}` and no image (rare once PD12M is seeded).
6. **Response:** `{ created, data:[{url}], shared_cache:{ result, similarity, cost_saved_usd, model_used,
   source, sizes:{thumb,medium,large} } }`.

Other routes: `POST /v1/keys/generate` (mint `sc-…`, store `sha256` in D1, **rate-limited per client IP via
the native Cloudflare Rate Limiting binding** — an in-isolate counter like the Task-3 `SlidingWindowLimiter`
is unreliable across Worker instances, so the binding replaces it at the edge); `GET /healthz`.

## 6. Backfill worker (Python, demand-ranked)

Entry: `python -m sharedcache.backfill` (env-config; `--once` for a single tick, else loop every
`WORKER_INTERVAL_SECONDS`). Each **tick**:

1. **Generate pass:** `SELECT normalized_prompt, original_prompt, count FROM queries WHERE status='pending'
   ORDER BY count DESC LIMIT WORKER_BATCH_SIZE` (via D1 REST).
   For each, cheapest-first work:
   - **Re-check:** `clip_text_embed(prompt)` → Vectorize `query(topK=1)`; if `score ≥ floor`, `UPDATE queries
     SET status='built', last_asset_id=<id>` and continue (no generation).
   - **Generate:** Genblaze (GMI Cloud default) → image bytes; `clip_image_embed(bytes)`; `derive_sizes` →
     upload 3 webp to B2; new asset `id`; Vectorize **upsert** `(id, image_vec, {source:'generated'})`;
     D1 insert the `assets` row (`locally_cached=1`); `UPDATE queries SET status='built', last_asset_id=id`.
   - Track spend; stop the pass at `WORKER_MAX_SPEND_USD`.
2. **Rehost pass:** `SELECT id, source_url FROM assets WHERE locally_cached=0 LIMIT WORKER_BATCH_SIZE`.
   For each: download `source_url` → `derive_sizes` → upload 3 webp to B2 → `UPDATE assets SET url,
   medium_url, thumb_url, width, height, mime, locally_cached=1`. (The Vectorize vector already exists from
   seeding; unchanged.) Reuses the Task-6 `derive_sizes` / `ensure_local` logic.

**Cloudflare REST clients** (`d1_client.py`, `vectorize_client.py`), authed with `CF_API_TOKEN`:
- D1 query: `POST /accounts/{CF_ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}/query` with `{sql, params}`.
- Vectorize v2: `.../vectorize/v2/indexes/{VECTORIZE_INDEX_NAME}/query` (by vector),
  `.../upsert` (ndjson) for generated vectors, `.../insert` for bulk seed.

## 7. Seeding PD12M

`scripts/seed_pd12m.py` (rewritten for the new stores):
1. Read PD12M rows + **precomputed CLIP vectors** from the HF dataset (bulk).
2. Vectorize **insert** `(asset_id, pd12m_vector, {source:'pd12m'})` in batches.
3. D1 insert `assets` rows: `source='pd12m'`, `source_id=<row id>`, `model_used='clip-vit-l-14'`,
   `url = source_url = <external image url>`, `locally_cached=0`.
4. Rehost is lazy (Worker serves `source_url`; backfill rehosts on demand) — no eager B2 upload at seed.

## 8. Reused vs replaced (from the current branch)

**Reused (Python → backfill + shared libs):** `generator.py` (Genblaze/GMI, generic `model_used`/`source`),
`processor.py` (`derive_sizes`), `storage.py` (B2), `models.py`, the CLIP embedder (extend with
`clip_image_embed`), the demand-ranking + re-check logic (port of the Task-10 worker), and the Task-3 key
hashing (now applied to D1 `api_keys`).

**Replaced:** FastAPI `api.py` request path → the Worker; `index.py` `PgCacheIndex`/Postgres/pgvector →
Vectorize + D1; the in-process asyncio worker → the standalone backfill; `scripts/migrate.sql` (Postgres) →
`worker/migrations/*.sql` (D1). `InMemoryCacheIndex`/`InMemoryStorage` stay for offline unit tests.

## 9. Repo layout & deployment

```
worker/                      # Cloudflare Worker (TypeScript)
  src/index.ts               # router: /v1/images/generations, /v1/keys/generate, /healthz
  src/auth.ts                # bearer + D1 key-hash check
  src/embed.ts               # clip_text_embed via CLIP_TEXT_EMBED_URL
  src/vectorize.ts           # query wrapper
  src/d1.ts                  # asset/query/key SQL
  src/floor.ts               # cache_tolerance -> CLIP-scale floor (calibrated §3)
  migrations/0001_init.sql   # D1 schema
  wrangler.toml              # D1 + Vectorize + Rate-Limit bindings, CLIP_TEXT_EMBED_URL
  test/                      # vitest + @cloudflare/vitest-pool-workers
src/sharedcache/             # Python backfill + shared libs
  backfill.py                # entry: generate pass + rehost pass, loop/--once
  d1_client.py               # D1 REST
  vectorize_client.py        # Vectorize REST
  embedder.py                # + clip_image_embed / clip_text_embed
  generator.py processor.py storage.py models.py   # reused
  Dockerfile                 # for the GMI Hermes agentbox
scripts/seed_pd12m.py        # bulk seed Vectorize + D1
```

Deploy: `wrangler deploy` (Worker) after `wrangler d1 migrations apply` and `wrangler vectorize create`;
backfill via `python -m sharedcache.backfill` locally or the container in a GMI Hermes agentbox.

### Environment
- **Worker (wrangler vars/secrets):** `MASTER_API_KEY`, `CLIP_TEXT_EMBED_URL`, `CLIP_EMBED_TOKEN?`,
  `IMAGE_PRICE_USD`, `FLOOR_SIM_MAX`, `FLOOR_SIM_MIN`; bindings `DB` (D1), `VECTORIZE`, rate-limiter.
- **Backfill (env):** `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DATABASE_ID`, `VECTORIZE_INDEX_NAME`,
  `CLIP_TEXT_EMBED_URL`, `CLIP_IMAGE_EMBED_URL`, `CLIP_EMBED_TOKEN?`, `GMICLOUD_API_KEY` (+optional other
  providers), `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`, `B2_PUBLIC_URL_BASE`, `IMAGE_PRICE_USD`,
  `WORKER_BATCH_SIZE`, `WORKER_MAX_SPEND_USD`, `WORKER_INTERVAL_SECONDS`, `FLOOR_SIM_MAX`, `FLOOR_SIM_MIN`.

## 10. Testing

- **Worker:** `vitest` + `@cloudflare/vitest-pool-workers` (Miniflare) with a local D1 (apply migrations) and
  a **fake Vectorize** + **mocked CLIP fetch**. Assert: auth (master key, D1 key, reject), 422 on `n!=1`,
  and each branch (hit / hit-not-rehosted returns source_url / approximate marks pending / empty→202), plus
  query upsert + count increment.
- **Python backfill:** `pytest` with in-memory fakes for `d1_client`/`vectorize_client`, `StubGenerator`,
  `InMemoryStorage`, and mocked CLIP. Assert: demand ranking (highest count first), **re-check skips
  generation when a match exists**, generate→embed→B2→upsert→D1→mark-built, spend cap halts a pass, and the
  rehost pass (download-failure is graceful). `derive_sizes` and Genblaze/B2 units keep their existing
  offline tests.

## 11. Rollout / sequencing

- **Phase A — scaffold:** `worker/` skeleton, `wrangler.toml`, D1 migration, `wrangler vectorize create`.
- **Phase B — Worker request path:** auth, embed, Vectorize query, D1 read/log, branch, response; vitest.
- **Phase C — REST clients + backfill:** `d1_client`, `vectorize_client`, `backfill.py` (generate + rehost,
  ranking, re-check, spend cap); pytest.
- **Phase D — seed PD12M:** bulk Vectorize insert + D1 rows; calibrate `FLOOR_SIM_*` against the seeded pool.
- **Phase E — keygen + rate limit + docs + Dockerfile + deploy runbook.**
- **Retire:** delete/park FastAPI `api.py` request path, `PgCacheIndex`, `migrate.sql`, in-process worker
  once the Worker+backfill reach parity (keep git history; the demand-driven branch work informs the ports).

## 12. Open assumptions (correct me if wrong)

- PD12M's shipped embeddings are CLIP ViT-L/14 **image** vectors, 768-dim, L2-normalized for cosine — confirm
  when wiring the seed loader; if they are caption-**text** vectors, matching becomes text↔text (still works,
  not cross-modal) and §3 calibration shifts.
- `FLOOR_SIM_MAX/MIN` start at 0.35/0.18 and are tuned empirically against the seeded pool (CLIP cross-modal
  cosines are low); exposed as env so tuning needs no redeploy.
- The Worker does not generate; a not-yet-rehosted PD12M hit serves the external `source_url` and the backfill
  rehosts afterward; empty-pool returns `202`.
- CLIP text and image embedding are reachable as two HTTPS endpoints (HF Inference by default, swappable to a
  self-hosted GMI endpoint later).
- The GMI "Hermes agentbox" is treated as a container runtime for the backfill (env-config, stateless, loop or
  `--once`); no Hermes-specific API is assumed.
