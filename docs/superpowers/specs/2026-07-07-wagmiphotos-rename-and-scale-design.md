# wagmiphotos rename + PD12M-scale storage — design

**Date:** 2026-07-07
**Status:** approved (user, this session)
**Depends on:** the 2026-07-07 audit fix sweep (contract.json, migration 0006, DEV_MODE) already in the working tree.

## Context

The product ships under wagmi.photos but the repo still uses the legacy
"sharedcache" name for every deploy identity and package. Nothing is
provisioned in production yet (`database_id` is a placeholder; Task 6
live-provisioning is pending), so renaming now is free; after PD12M seeding it
would mean data migrations.

Target library scale is PD12M: ~12.4M images. Two platform limits bite:

- **Vectorize: 10M vectors per index** (verified 2026-07-07). One index cannot
  hold PD12M.
- **D1: 10GB per database.** 12.4M asset rows at ~600-800B each (four stored
  URLs dominate) is 7-10GB — borderline before the queries table.
- **`GET /v1/library?q=`** is a SQL `LIKE '%token%'` full scan over
  `assets.prompt`; at 12M rows it will crawl into D1's 30s query cap.

Four parts, one release: (1) full rename, (2) Vectorize sharding, (3) derived
asset URLs, (4) semantic library search. Decisions below were made with the
user: full rename depth; 3 shards.

## Part 1 — Full rename (sharedcache → wagmiphotos)

Pure rename: **no behavior change**; both test suites must pass unmodified
except for name literals.

| Where | Old | New |
|---|---|---|
| Worker deploy name (`wrangler.toml:1`, `package.json`) | `sharedcache-worker` | `wagmiphotos-worker` |
| D1 database (`wrangler.toml`, all docs/commands/skills) | `sharedcache` | `wagmiphotos` |
| Python dists (3 pyprojects) | `sharedcache-{common,generation,backfill}` | `wagmiphotos-{common,generation,backfill}` |
| Python namespace (src dirs, every import) | `sharedcache.*` | `wagmiphotos.*` |
| Console script | `sharedcache-backfill` | `wagmiphotos-backfill` |
| Root workspace (`pyproject.toml`) | `sharedcache` | `wagmiphotos` |
| Model-id prefix (`build_model_id`/`parse_model_id`, Python only) | `shared-cache-<provider>-<model>` | `wagmiphotos-<provider>-<model>` |
| SPA localStorage keys | `sharedcache_*` | `wagmiphotos_*` + one-time read-old-key fallback so saved stats survive |
| Docs/examples (README, DEPLOY, HANDOFF, TODO, .env.example, running-locally skill + seed) | SharedCache / sharedcache | wagmiphotos |

**Not renamed:** the checkout directory path, git history/origin (already
wagmiphotos), `docs/archive/**` and dated historical docs, external genblaze
package names. Local D1 state is keyed by database name → local dev does one
re-migrate + re-seed afterward (state is gitignored; skill covers it).

## Part 2 — Vectorize sharding (3 × 10M)

**Approach chosen:** static hash-sharding across N independent indexes with
query fan-out. Rejected: namespaces (the 10M cap is per index) and
shard-by-source (PD12M alone exceeds one index; lopsided fill).

- **Indexes:** `wagmiphotos-bge-0`, `wagmiphotos-bge-1`, `wagmiphotos-bge-2` —
  768 dims, cosine, created via `wrangler vectorize create` (DEPLOY.md gets the
  three commands; replaces the single `wagmiphotos-bge`).
- **Write routing:** `shard = fnv1a32(asset_id) % 3`. FNV-1a 32-bit over the
  UTF-8 bytes of the id (offset basis 2166136261, prime 16777619, unsigned
  32-bit wraparound). Implemented identically in TS and Python.
- **Read fan-out:** queries go to ALL shards in parallel; results merge by
  score descending (cosine scores from identically-configured indexes are
  directly comparable); take top-k. The Worker only ever reads; the Python
  backfill reads (re-check) and writes (upsert/insert_many, routed).
- **contract.json additions** (pinned by parity tests on both sides, same
  pattern as the floors):
  - `vectorize_index_prefix: "wagmiphotos-bge-"`
  - `vectorize_shards: 3`
  - `shard_fixtures`: map of ≥5 representative ids (uuid4s + `demo-1`-style
    ids) → expected shard, generated once from the reference implementation at
    build time; both suites assert their hash agrees.
- **Worker:** three bindings `VECTORIZE_0/1/2` (`[[vectorize]]` blocks in
  wrangler.toml). `makeVectorize(bindings: VectorizeIndex[])` keeps the
  existing `VectorizeStore.query` interface; internally `Promise.all` fan-out +
  merge. Shard count in code comes from the bindings array length.
- **Python:** `VectorizeClient(account, index_prefix, shards, token, dims)`
  with `shard_for(id)`; `upsert` routes by id; `insert_many` groups vectors by
  shard and issues one insert per shard; `query` fans out and merges.
  `config.py`: `vectorize_index_name` → `vectorize_index_prefix`
  (default `wagmiphotos-bge-`) + `vectorize_shards` (default 3).
- **Growth path (documented, not built):** adding shard N+1 later is safe for
  reads (fan-out covers all shards). Write idempotency for pre-existing ids
  breaks (`hash % N` changes), so adding a shard requires either a reindex or
  accepting that re-upserts of old assets could duplicate; vectors are written
  once per asset today, so exposure is minimal.

## Part 3 — Derived asset URLs (migration 0007)

Asset URLs become pure functions of `(id, locally_cached, source_url)` instead
of stored columns.

- **Migration `0007_derived_urls.sql`:** `ALTER TABLE assets DROP COLUMN` for
  `thumb_url`, `medium_url`, `url`, `manifest_url`. Keep `source_url`,
  `locally_cached`, `mime`, `width`, `height`. (No production data exists;
  local data is re-seedable.) Saves ~300B/row ≈ 3.7GB at PD12M scale.
- **Derivation rule** (one helper per language, e.g. TS `assetUrls(asset,
  env)`, Python `asset_urls(rec, base)`):
  - `locally_cached=1` → `{ASSET_BASE_URL}/{path}` using the path templates
    below; thumb/medium/large/manifest all derived.
  - `locally_cached=0` → `url = source_url`, thumb/medium/manifest = null.
    (SPA already falls back `thumb_url || medium_url || url`.)
  - Defensive: `locally_cached=1` with `ASSET_BASE_URL` unset → serve
    `source_url` and log a warning (misconfiguration, not a crash).
- **contract.json addition:** `asset_paths` =
  `{large: "assets/{id}/image.webp", medium: "assets/{id}/medium.webp",
  thumb: "assets/{id}/thumb.webp", manifest: "assets/{id}/manifest.json"}` —
  exactly the keys the backfill already writes to B2; parity-tested both sides.
- **Worker:** new env var `ASSET_BASE_URL` (the B2 friendly-URL base; same
  value as Python's `b2_public_url_base`). `AssetRow` drops the four URL
  fields; handler/library/download build responses via the helper. **The public
  API response shape does not change** (`data[0].url`,
  `shared_cache.sizes{thumb,medium,large}`, library `images[]` fields).
- **Python:** `AssetRecord` drops `url/thumb_url/medium_url/manifest_url`;
  `insert_asset` slims; `update_asset_urls` → `mark_asset_rehosted(id, width,
  height, mime)` (sets `locally_cached=1`, no URLs). The backfill still uploads
  to the conventional B2 paths — that contract is what makes derivation valid.
- **Demo seed (`seed-demo.sql`):** rows become `locally_cached=0` with
  `source_url` pointing at the bundled `public/assets/*.webp` files; grid and
  download proxy keep working offline via the `url = source_url` rule.

## Part 4 — Semantic library search

`GET /v1/library` with non-empty `q`:

1. Embed `q` with the existing BGE Workers-AI call (same as generation).
2. Fan out to all shards, `topK: 100`, no values/metadata (100 is the cap).
3. Merge by score desc; drop matches below `FLOOR_SIM_MIN` (0.72) as a
   relevance floor; dedupe ids.
4. Slice `[offset, offset+limit)` within that merged window (≤100 results per
   query is the pagination ceiling for search mode; `has_more` reflects the
   window).
5. Fetch the page's rows from D1 with one `WHERE id IN (...)` (≤60 ids, under
   the 100-param cap), reorder by similarity, return the existing public shape.

Empty `q` keeps the existing indexed recency browse (0003 index) — unchanged.

**LIKE becomes a fallback, not the path:** if the embed or any shard query
throws (exactly the offline local-dev case — Workers AI and Vectorize have no
local emulation), log a warning and run the existing LIKE search instead. Local
`wrangler dev` library search keeps working; production gets an emergency
degrade path. FTS5-in-D1 was rejected: it re-adds ~0.5-1GB of index to the
same 10GB budget Part 3 shrinks, and does keyword matching in a product whose
story is semantic matching.

**Behavior change (accepted):** search results are similarity-ordered semantic
matches capped at 100, not substring matches by recency. Docs page copy in the
SPA mentions library search — update if it describes substring behavior.

## Testing

- **Rename:** both suites green with only name-literal test edits; grep gates:
  no `sharedcache` outside `docs/archive/`, git history, and the localStorage
  fallback read; zero `shared-cache` model-prefix occurrences (clean rename, no
  backward compatibility — no model ids exist outside this repo).
- **Sharding:** fnv1a32 parity via `shard_fixtures` (both languages); TS merge
  test (3 fake shards, interleaved scores → sorted top-k); Python routing test
  (`insert_many` groups correctly, `upsert` routes deterministically); the
  all-migrations D1 test keeps executing real SQL.
- **Derived URLs:** path-template parity tests both sides; handler/library
  tests for locally_cached 0/1 and unset-base fallback; migration 0007 joins
  the migration test; seed-demo verified in the boot smoke test.
- **Semantic search:** handler tests with fake embedder+shards (ordering,
  floor cutoff, offset window, has_more); fallback test (embedder throws →
  LIKE results); Python untouched here.
- **End-to-end:** local re-migrate + re-seed + boot; browse, search (exercises
  the LIKE fallback offline), login, keygen, and the generation 500 path all
  driven as in the running-locally skill.

## Rollout / deploy notes

- DEPLOY.md provisioning: `wrangler d1 create wagmiphotos`, three
  `wrangler vectorize create wagmiphotos-bge-{0,1,2} --dimensions=768
  --metric=cosine`, set `ASSET_BASE_URL`, and the rename means any previously
  deployed `sharedcache-worker` (none known) would be orphaned, not upgraded.
- The old single `wagmiphotos-bge` index (if it was ever created) is retired;
  DEPLOY notes deleting it.
- Memory/skill files that name the D1 database, index, or 502 behavior get
  updated in the same change.

## Out of scope

- Rebalancing/reindex tooling for shard-count changes (documented risk only).
- FTS5, cursor pagination beyond the 100-result search window.
- Repo/directory rename on disk; git history rewrite.
- D1 database splitting (the 10GB headroom after Part 3 is sufficient for
  PD12M + queries growth; revisit if the library outgrows ~25M assets).
