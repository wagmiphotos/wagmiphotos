# Demand-Driven Cache with Background Build — Design Spec

**Date:** 2026-07-01
**Status:** Approved for planning
**Supersedes/extends:** `docs/specs/2026-06-23-sharedcache-design.md` (the original MVP cache design)

## 1. Summary

Today SharedCache serves a cached image on a semantic HIT and **synchronously generates**
(via the server's provider key) on a MISS. This change turns it into a **demand-driven cache**:

- **Every request always returns an image.** On a miss we return the nearest available asset
  (flagged `approximate`) instead of blocking on generation.
- **Every query is logged and counted.** We store the prompt, its embedding, an outcome
  (`hit` / `approximate` / `generated`), the asset we returned, and a per-prompt request counter.
- **A background worker builds the most-requested missing images first.** It runs in-process on a
  timer, ranks pending queries by request count, and generates the real images — bounded by a batch
  size and a spend cap. Before generating each one it **re-checks** the index, so anything generated
  in the meantime (including by a near-duplicate prompt) is reused instead of re-generated.
- **Assets are lazily rehosted to Backblaze B2 in three sizes** (thumbnail / medium / large, all
  webp) on first serve, from their original `source_url` (e.g. a seeded PD12M image).
- **Provider is generic and defaults to GMI Cloud.** OpenAI-specific fields are removed; each asset
  records a generic `model_used` string plus a `source` origin.

This spec also folds in the approved security/correctness fixes from the prior review
(#1 key-mint abuse, #2 `dev-key` backdoor, #5 dead `/memory` route, #6 non-idempotent migration,
plus plaintext key storage and the `$0-saved` pricing gap).

## 2. Goals / non-goals

**Goals**
- Sub-second responses on every request (no synchronous generation on the default path).
- Persist a demand signal (prompt + count) usable to prioritise background generation.
- Never generate the same image twice when a match already exists.
- Multi-size, B2-hosted, webp assets that render publicly.
- Generic multi-provider generation defaulting to GMI Cloud.

**Non-goals**
- Semantic clustering of prompts for the counter (we use exact normalized-prompt identity).
- A separate worker process / external scheduler (in-process asyncio only).
- Cloudflare R2 (storage stays on B2; "R2" in the request was shorthand for our bucket).
- Per-key usage/billing endpoints (out of scope; `savings_ledger` remains a demo counter).

## 3. Data model

### 3.1 `assets` (extend existing table)

Add generic/origin/multi-size columns; **remove reliance on `provider`+`model`** in favour of a single
`model_used`. Existing `provider`/`model` columns are left in place but nullable and unused (dropping
them is optional cleanup, not required).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | unchanged |
| `prompt` | TEXT | unchanged |
| `url` | TEXT | **large** webp URL (primary; keeps OpenAI-compat `data[0].url`) |
| `thumb_url` | TEXT NULL | thumbnail webp URL |
| `medium_url` | TEXT NULL | **new** — medium webp URL |
| `model_used` | TEXT | **new** — generic model id that produced the image (e.g. GMI model), or `pd12m-clip` for seeds |
| `source` | TEXT | **new** — origin: `pd12m` \| `generated` \| `stub` |
| `source_id` | TEXT NULL | **new** — external id within the source (e.g. PD12M row id) |
| `content_hash` | TEXT | unchanged (sha256; seeds use `pd12m-<idx>`) |
| `width`, `height` | INT | dimensions of the large asset |
| `mime` | TEXT | `image/webp` once rehosted |
| `manifest_url` | TEXT NULL | provenance manifest (generated assets only) |
| `source_url` | TEXT NULL | original external URL to rehost from |
| `locally_cached` | BOOLEAN | true once all three sizes are on B2 |
| `embedding` | vector(N) | unchanged |
| `created_at` | TIMESTAMPTZ | unchanged |

### 3.2 `queries` (new table)

One row per distinct normalized prompt.

| Column | Type | Notes |
|---|---|---|
| `normalized_prompt` | TEXT PRIMARY KEY | `" ".join(prompt.strip().lower().split())` |
| `original_prompt` | TEXT | last raw prompt seen |
| `embedding` | vector(N) | prompt embedding (for the worker re-check) |
| `count` | INT NOT NULL DEFAULT 1 | incremented every request |
| `status` | TEXT NOT NULL | `pending` (needs an exact build) \| `built` (exact asset exists) |
| `last_asset_id` | UUID NULL | asset returned/linked last |
| `last_similarity` | REAL NULL | similarity of last served asset |
| `first_seen`, `last_seen` | TIMESTAMPTZ | timestamps |

Status rules:
- `hit` or `generated` outcome → `status='built'`, `last_asset_id` = exact asset.
- `approximate` outcome → `status='pending'` (unless already `built`).
- `count` increments on **every** request regardless of outcome.

### 3.3 `api_keys` (change: store a hash)

`key` column stores `sha256(raw_key)` hex, not the raw key. The raw `sc-…` key is shown to the caller
once at creation and never persisted in plaintext.

## 4. Interfaces / new abstractions

Follows the existing Protocol-per-collaborator pattern (`Embedder`, `CacheIndex`, `Generator`,
`Storage`) so everything stays offline-testable with in-memory implementations.

### 4.1 `QueryLog` protocol (new module `query_log.py`)

```python
@dataclass
class QueryStat:
    normalized_prompt: str
    original_prompt: str
    embedding: list[float]
    count: int
    status: str
    last_asset_id: str | None

class QueryLog(Protocol):
    def record(self, *, prompt: str, embedding: list[float], outcome: str,
               asset_id: str | None, similarity: float) -> None: ...
    def top_pending(self, limit: int) -> list[QueryStat]: ...   # status='pending', ORDER BY count DESC
    def mark_built(self, normalized_prompt: str, asset_id: str) -> None: ...
```

Implementations: `InMemoryQueryLog` (dict keyed by normalized prompt) and `PgQueryLog`
(the `queries` table). `record()` performs the upsert + counter increment + status transition.

### 4.2 `CacheIndex` (extend)

Add `def ensure_ready()` is **not** needed. No signature changes beyond what already exists;
`update_url` is generalised to persist the three size URLs:

```python
def update_urls(self, asset_id: str, *, url: str, medium_url: str, thumb_url: str,
                width: int, height: int, mime: str, locally_cached: bool) -> None: ...
```

(replaces the current single-URL `update_url`).

### 4.3 `Generator` (genericised)

`Generated` drops `provider`/`model`, gains `model_used: str` and `source: str`. `GenblazeGenerator`
keeps an **internal** provider dispatch (which Genblaze SDK to call) derived from config/model-id, but
that provider name is not stored on the asset. Default dispatch is **gmicloud**.

### 4.4 `CacheService` (extend)

- Add a public `storage` property (`return self._storage`) — **fixes dead `/memory` route (#5)**.
- Add `ensure_local(record)` helper: the multi-size lazy-rehost routine (section 6), reused by both
  the request path and the worker.
- `generate(...)` gains `force_generate: bool = False` and now branches per section 5.

### 4.5 `BackgroundBuilder` (new module `worker.py`)

```python
class BackgroundBuilder:
    def __init__(self, service, query_log, *, floor_tolerance, batch_size,
                 interval_seconds, max_spend_usd, price_usd): ...
    async def tick(self) -> None: ...          # one pass; testable in isolation
    async def run_forever(self) -> None: ...    # loop with asyncio.sleep(interval)
```

## 5. Request flow — `POST /v1/images/generations`

1. `model_id` resolved (alias `image-cache-1` → `shared-cache-gmicloud-<DEFAULT_IMAGE_MODEL>`).
2. Authenticate (`_check`) and resolve any BYOK provider key (section 8).
3. `embedding = embedder.embed(prompt)`; `top = index.search(embedding, k=1)`; `floor = similarity_floor(cache_tolerance)`.
4. Branch (first match wins):
   1. **`force_generate` is true → `generated`:** explicit opt-in — generate a fresh image now even if a
      cache hit exists. Insert a new asset (`source='generated'`), `cost_saved = 0`.
   2. **`top` exists and `sim ≥ floor` → `hit`:** `ensure_local(asset)`; `cost_saved = IMAGE_PRICE_USD`.
      (A plain BYOK caller still prefers a hit — it saves them money — so BYOK does not override this.)
   3. **BYOK key present (below floor) → `generated`:** the caller brought a provider key and there is no
      good match, so generate the exact image now; insert (`source='generated'`), `cost_saved = 0`.
   4. **`top` exists (below floor, no BYOK) → `approximate`:** `ensure_local(nearest)`; return nearest
      anyway; `cost_saved = IMAGE_PRICE_USD` (a live generation was avoided). Query becomes `pending`.
   5. **pool empty → fallback:** generate with the server key if configured, else `StubGenerator`,
      so the response still carries an image. Outcome `generated`/`stub`.
5. `query_log.record(prompt, embedding, outcome, asset_id, sim)`.
6. Response:

```json
{
  "created": 1751000000,
  "data": [{ "url": "<large webp url>" }],
  "shared_cache": {
    "result": "hit | approximate | generated",
    "similarity": 0.83,
    "cost_saved_usd": 0.04,
    "model_used": "<model>",
    "source": "pd12m | generated | stub",
    "sizes": { "thumb": "…thumb.webp", "medium": "…medium.webp", "large": "…image.webp" },
    "provenance_url": "<manifest url or null>"
  }
}
```

`GenRequest` gains `force_generate: bool = False`.

## 6. Multi-size lazy rehost

New `processor.derive_sizes(image_bytes) -> dict[str, bytes]` producing webp at:

| Size | Max dimension | Key |
|---|---|---|
| `thumb` | 256 px (longest side) | `assets/<id>/thumb.webp` |
| `medium` | 768 px | `assets/<id>/medium.webp` |
| `large` | full resolution (no upscale) | `assets/<id>/image.webp` |

`CacheService.ensure_local(record)` (used by request path and worker):
1. If `record.locally_cached` → return.
2. `src = record.source_url or record.url`; `bytes = httpx GET src` (timeout, follow redirects).
3. `sizes = derive_sizes(bytes)`; `w,h = dimensions(large)`.
4. `put` each size to B2; `index.update_urls(...)`; mutate record fields; `locally_cached=True`.
5. On any failure: log to stderr and return the record unchanged (still serve the external URL).
   Errors are **not** swallowed silently past logging — the failure path is covered by tests.

## 7. Background worker

- Started from FastAPI **lifespan** on startup when `WORKER_ENABLED` and a server provider key exist;
  cancelled on shutdown.
- `tick()`:
  1. `pending = query_log.top_pending(WORKER_BATCH_SIZE)` (ordered by `count` desc).
  2. `spent = 0.0`.
  3. For each `q`:
     - **Re-check:** `top = index.search(q.embedding, 1)`; if `top` and `sim ≥ floor`:
       `query_log.mark_built(q.normalized_prompt, top.id)` and `continue` (no generation).
     - Else generate via the server provider (`source='generated'`, `model_used=<model>`), insert the
       asset, `ensure_local` it, `mark_built`. `spent += price_usd`.
     - If `spent >= WORKER_MAX_SPEND_USD`: stop this tick.
- `run_forever()`: `while True: await tick(); await asyncio.sleep(WORKER_INTERVAL_SECONDS)` with
  a broad try/except around `tick()` so one failure doesn't kill the loop.

## 8. Auth & security fixes

- **Remove the `dev-key` backdoor (#2):** delete the hardcoded `token == "dev-key"` branch and the
  `{"dev-key"}` seed in `InMemoryCacheIndex`. `.env.example` ships `API_KEY=` (empty), not `dev-key`.
- **`_check` behaviour:** if `api_key` is unset → open (dev/offline). If set → accept the exact
  `api_key`, a DB-verified `sc-…` key, or a BYOK-format provider key (`gmi-`, `AIzaSy`, `sk-`/`sk-proj-`).
  BYOK-format acceptance only grants cache access (it no longer unlocks server-key generation), so the
  residual risk is low. Default provider for format-checking is `gmicloud`.
- **Key-mint hardening (#1):** `/v1/keys/generate` stays public (playground self-serve) but gains a
  simple in-memory per-IP sliding-window rate limit (default 10/hour). Generated keys are stored
  **hashed** (section 3.3). Combined with the worker spend cap, key minting can no longer drive
  unbounded provider cost.
- **Worker spend cap:** `WORKER_MAX_SPEND_USD` bounds server generation per tick.

## 9. Configuration (new/changed `Settings`)

| Setting | Default | Purpose |
|---|---|---|
| `default_provider` | `gmicloud` | internal dispatch when none in model id |
| `default_image_model` | operator-set (e.g. GMI model id) | inner model for the `image-cache-1` alias |
| `image_price_usd` | `0.04` | flat cost-saved estimate per avoided generation |
| `worker_enabled` | `true` | start the in-process builder |
| `worker_interval_seconds` | `300` | tick cadence |
| `worker_batch_size` | `5` | queries per tick |
| `worker_max_spend_usd` | `5.0` | spend ceiling per tick |
| `keygen_rate_per_hour` | `10` | `/v1/keys/generate` per-IP limit |

`gmicloud_api_key` already exists. `openai_api_key` retained for optional BYOK but no longer the default.

## 10. Migration (`scripts/migrate.sql`, idempotent — fixes #6)

Keep the templated `vector(__EMBEDDING_DIMS__)`. Structure:
- `CREATE TABLE IF NOT EXISTS assets (…)` — fresh installs get `model_used`/`source`/`source_id`/
  `medium_url`/`source_url`/`locally_cached` and **no** `provider`/`model` columns.
- Evolution block for existing DBs (safe on both fresh and legacy):
  ```sql
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS medium_url  TEXT;
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS model_used  TEXT;
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS source      TEXT;
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_id   TEXT;
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_url  TEXT;
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS locally_cached BOOLEAN NOT NULL DEFAULT TRUE;
  ```
- Legacy `provider`/`model` are `NOT NULL` on pre-existing tables but we stop populating them, so drop
  the constraint **only if the column exists** (guarded so it's a no-op on fresh installs):
  ```sql
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='assets' AND column_name='provider') THEN
      ALTER TABLE assets ALTER COLUMN provider DROP NOT NULL;
      ALTER TABLE assets ALTER COLUMN model    DROP NOT NULL;
    END IF;
  END $$;
  ```
- `CREATE TABLE IF NOT EXISTS queries (…)` with `vector(__EMBEDDING_DIMS__)`.
- `api_keys` unchanged in shape (values are now hashes).

`seed_pd12m.py` updates: set `source='pd12m'`, `source_id=<row id>`, `model_used='pd12m-clip'`,
`locally_cached=False`, `source_url=<external url>` (drops `provider`/`model`).

## 11. Testing (offline, stub + in-memory)

New/updated tests:
- `test_query_log.py` — record upsert & count increment; status transitions; `top_pending` ordering by count; `mark_built`.
- `test_worker.py` — `tick()` builds highest-count pending first; **re-check skips generation when a match now exists**; spend cap halts a tick; disabled when no server key.
- `test_cache_service.py` — approximate-return-on-miss (below floor still returns nearest + logs pending); BYOK/`force_generate` live path; hit path.
- `test_cache_lazy.py` — multi-size rehost writes thumb/medium/large & flips `locally_cached`; **download-failure path** (status≠200 / timeout) returns gracefully and is asserted.
- `test_processor.py` — `derive_sizes` dimensions/format for each size.
- `test_api.py` — response includes `sizes`/`model_used`/`source`; `dev-key` no longer authenticates; keygen rate limit; `/memory` route serves bytes (regression for #5).
- `test_migrate.py` (or extend) — migration SQL contains idempotent `ADD COLUMN IF NOT EXISTS` and the `queries` table (string-level assertion; live PG test stays skip-gated).

Target: full suite green offline; `WORKER_ENABLED=false` in the test environment so no loop starts.

## 12. Rollout / sequencing

- **Phase 0 — security fixes** (independent, land first): #5 dead route, #2 `dev-key`, keygen rate
  limit + key hashing.
- **Phase 1 — data model + generic provider:** migration, `models.py` (`model_used`/`source`/`medium_url`),
  `Generated`, GMI default, pricing→flat estimate, `seed_pd12m.py`.
- **Phase 2 — query log:** `QueryLog` protocol + in-memory/Pg impls + wiring into the request path.
- **Phase 3 — multi-size rehost:** `derive_sizes`, `ensure_local`, `update_urls`.
- **Phase 4 — request branching:** approximate-return + BYOK/force live gen + response shape.
- **Phase 5 — worker:** `BackgroundBuilder`, lifespan wiring, spend cap, re-check.
- **Phase 6 — tests + docs:** README/TODO updates; branding note (WagmiPhotos↔SharedCache) resolved separately.

## 13. Open assumptions (call out if wrong)

- `cost_saved_usd` is counted for **both** `hit` and `approximate` (any avoided live generation),
  as a flat `IMAGE_PRICE_USD`. If approximate serves should read `$0`, flip step 5.iii.
- Sizes 256 / 768 / full-res; worker defaults 300s / batch 5 / $5 cap.
- The exact GMI Cloud model id is operator-configured via `DEFAULT_IMAGE_MODEL`; tests use `StubGenerator`.
