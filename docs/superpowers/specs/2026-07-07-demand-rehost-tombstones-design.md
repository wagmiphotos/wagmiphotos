# Demand-ranked rehosting + tombstones

**Date:** 2026-07-07
**Status:** Approved

## Motivation

The rehost queue is unordered: `assets_needing_rehost` takes any
`locally_cached=0` rows up to the batch size. Before the big PD12M seed that
means the assets users actually hit wait behind an arbitrary tail, serving
slow full-size pd12m JPEGs with no thumbnails. Separately, an asset whose
source URL is permanently gone never leaves the library: after
`MAX_REHOST_ATTEMPTS` it stops being retried but keeps being served and
matched — a permanent broken image.

## Decisions

- **Demand comes from the queries table only.** The Worker already records
  every match (`count`, `last_asset_id`); the backfill ranks by
  `SUM(count) GROUP BY last_asset_id`. No new Worker writes, no second
  counter to drift.
- **Demand first, then trickle.** Demanded assets rehost first; leftover
  batch slots fill FIFO from the rest. (Demand-only mode for the 12M seed is
  a one-line follow-up: drop the trickle query.)
- **Tombstone on HTTP 404/410 immediately, and on retry exhaustion.**
  Nothing stays served-but-broken. A single-observation 404 kill is
  deliberate: S3 404s on public objects are near-always real deletions, and
  the tombstone is reversible (`UPDATE assets SET dead_at = NULL`; the
  caption can be re-embedded if the vector was already deleted).
- **Liveness is structural, not sprinkled.** A `live_assets` SQL view owns
  the `dead_at IS NULL` invariant; every read path that wants living assets
  selects from the view. Writes target `assets`.

## Design

### 1. Migration `0008_rehost_demand_tombstones.sql`

```sql
ALTER TABLE assets ADD COLUMN dead_at TEXT;      -- NULL = alive; timestamp = audit
ALTER TABLE assets ADD COLUMN dead_reason TEXT;  -- short: 'http 404', 'retries exhausted'
CREATE INDEX idx_assets_rehostable ON assets(rowid)
  WHERE locally_cached = 0 AND dead_at IS NULL;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
```

SQLite expands the view's `*` at creation time; the view is created after
the ALTERs so it includes the new columns. Any future migration that adds
asset columns must recreate the view (note this in the migration's header
comment).

### 2. Demand-ranked selection (`projects/common/.../d1_client.py`)

`assets_needing_rehost(limit)` becomes two queries, callers unchanged:

1. Demanded rows — start from the small side (one row per unique prompt),
   never scanning the assets table:

```sql
SELECT a.<ASSET_COLS> FROM (
  SELECT last_asset_id AS id, SUM(count) AS demand FROM queries
  WHERE last_asset_id IS NOT NULL GROUP BY last_asset_id
) q JOIN live_assets a ON a.id = q.id
WHERE a.locally_cached = 0 AND a.rehost_attempts < {MAX_REHOST_ATTEMPTS}
ORDER BY q.demand DESC LIMIT ?
-- MAX_REHOST_ATTEMPTS interpolated from the module constant, as the
-- existing query does today.
```

2. If fewer than `limit` rows returned, the existing FIFO query (now
   `FROM live_assets`) fills the remainder with
   `AND a.id NOT IN (<picked ids>)` — batch sizes stay far under D1's
   100-bound-param cap.

The partial index serves both: the view inlines `dead_at IS NULL`, which
implies the index predicate together with `locally_cached = 0`.

### 3. Tombstoning in the rehost pass (`projects/backfill/.../worker.py`)

- `_download_capped` raises a new `SourceGone` exception on HTTP 404/410;
  other non-200s keep raising the generic error.
- Per-asset handling in `rehost_pass`:
  - `SourceGone` → `mark_asset_dead(id, "http <status>")`; no attempt spent.
  - Any other error → `increment_rehost_attempts(id)` (changed to
    `... RETURNING rehost_attempts`); if the returned count reached
    `MAX_REHOST_ATTEMPTS` → `mark_asset_dead(id, "retries exhausted")`.
- After marking dead in D1, best-effort delete the asset's vector; a delete
  failure is logged and left. Safe because the Worker match path already
  loop-skips vectors with no live D1 row (handler.ts) — a dangling vector
  degrades to a skipped match, never a broken image. D1-first ordering means
  a dead asset stops serving immediately even if its vector outlives it.
- `mark_asset_dead` sets `dead_at = datetime('now')` and `dead_reason`;
  idempotent (`WHERE dead_at IS NULL` guard so the first reason wins).
- Known pre-existing property, unchanged: the rehost pass has no claim
  mechanism, so two concurrent backfill workers would double-download a
  batch. Harmless (idempotent puts, no paid spend); we run one worker.

### 4. Vectorize delete (`projects/common/.../vectorize_client.py`)

New `delete(ids)` method: group ids by the existing
`fnv1a32(id) % shards` routing and POST each group to that shard's
`/delete_by_ids` endpoint, following the same auth and error conventions as
`upsert`.

### 5. Read-path exclusions via `live_assets`

Switch `FROM assets` → `FROM live_assets` in every living-assets read:

- Worker `d1.ts`: `getAsset` (covers the match path and library download),
  library browse/search SQL, `getAssetsByIds` (semantic-search hydration).
  `ASSET_COLS` is unchanged; `dead_at`/`dead_reason` are never selected, so
  no API shape change.
- Python `d1_client.py`: `asset_exists` (a dead asset can no longer satisfy
  pending demand in `generate_pass` — the prompt re-queues for generation),
  and both `assets_needing_rehost` queries (§2).

Queries already marked `built` against a now-dead asset are left alone: the
next request for that prompt re-matches live assets via Vectorize and
re-records — the existing self-healing path.

### 6. Error handling

- Worker: read-side filters only; no new failure modes.
- Backfill: `SourceGone` and exhaustion both funnel through
  `mark_asset_dead`, which runs before vector deletion. If the D1 write
  fails, the existing per-asset exception isolation logs and moves on; the
  asset is retried next tick.

### 7. Testing

- `d1_client` (Python): demanded assets first, ordered by summed count;
  trickle fills remaining slots without duplicating demanded ids; dead and
  attempt-exhausted rows excluded from both queries; `mark_asset_dead`
  idempotent (first reason wins); `asset_exists` false for dead rows.
- Backfill worker: 404 → dead + vector delete called + no attempt
  increment; 410 the same; generic failure ×MAX → dead with
  "retries exhausted"; vector-delete failure leaves the asset dead and the
  pass alive.
- Worker (vitest): `getAsset` null for dead rows (match path serves
  next-best via the existing orphan-skip loop); library browse/search and
  hydration exclude dead; download 404s for a dead id.
- Migration test pins 0008's columns, index, and view (0006 test pattern).
- Contract: no changes — no new cross-language constants.

## Out of scope

- Demand-only mode for the 12M seed (drop the trickle query when needed).
- Re-queuing `built` queries when their asset is tombstoned.
- Periodic reconciliation sweep for dangling vectors.
- Any UI for dead assets.
