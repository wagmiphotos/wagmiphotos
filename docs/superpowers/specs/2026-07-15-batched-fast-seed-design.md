# Batched fast-seed — design

**Date:** 2026-07-15
**Status:** approved (build + use to finish the in-flight 250k batch)

## Problem

The PD12M seed writes **one row per HTTP round-trip** to D1 (`D1Client.insert_asset`
called per row inside `seed_rows`). Measured cost per row ≈ 230 ms, decomposed:

| Cost/row | Measured | Bottleneck? |
|---|---|---|
| Network RTT to Cloudflare | ~6 ms (ping) | no |
| BGE embed, 1-at-a-time (CPU) | ~19 ms (4 ms batched) | minor |
| **D1 insert — 1 HTTP request/row** | ~72 ms median, spikes 600–730 ms | **yes** |

At ~4.3 rows/s a 250k batch takes ~15 h. Internet speed is irrelevant (payloads are
tiny); the cost is *round-trip count × D1 server-side write latency*, one row at a time.

## Constraints (probed against prod D1)

- **D1 caps bound params at 100/statement** → a *parametrized* multi-row insert tops
  out at ~7 rows (13 cols/row). Confirmed: 130 bound params → HTTP 400 (code 7500).
- **Inlined multi-row `VALUES` text is accepted big**: 500-row and 2000-row `VALUES`
  (~13 KB SQL) both execute fine. This is the batching mechanism.

## Design

**1. `d1_client.build_bulk_insert_sql(recs) -> str`** — pure, unit-testable. Emits one
`INSERT INTO assets (<same 13 cols as INSERT_ASSET_SQL>) VALUES (…),(…),…` with values
**inlined + SQL-escaped**: strings wrapped in `'…'` with `'`→`''`; ints inline;
`None`→`NULL`; bool `locally_cached`→`1/0`. Same column list as the proven
`INSERT_ASSET_SQL`, so it is schema-safe by construction.

**2. `D1Client.insert_assets_many(recs, chunk=200)`** — chunks `recs`, builds SQL via
the helper, one `_exec` per chunk. `insert_asset` stays untouched (backfill worker
unaffected).

**3. `seed_pd12m.seed_from_parquet_fast(...)`** — same structure as
`seed_from_parquet` but: page size 500; dedup via existing `existing_source_ids`;
**batch-embed** the fresh page in one `encoder.encode([captions])`; write D1 via
`insert_assets_many`, then Vectorize `insert_many` (already batched; ≤~1000/shard).
Dedup-safe resume + orphan semantics unchanged (orphan surface = 1 page on crash).

**4. Driver** — reuse the absolute-target retry driver (recompute `remaining` from the
live count → overshoot-proof; resumes after a teardown). Points at the fast seed.

## Escaping correctness (the one real risk)

Captions are arbitrary dataset text. SQLite string literals only need `'`→`''`
(backslash is **not** special by default). This is the critical test surface.

## Testing (TDD, before any prod write)

- Unit (`build_bulk_insert_sql`): column order; escaping with adversarial captions
  (embedded `'`, unicode, newline, `;`); `None`→`NULL`; bool→`1/0`; chunk boundaries.
- Real-schema exec (extend `test_d1_migration.py`): apply all migrations to sqlite3,
  run the generated bulk SQL, assert rows land intact and match `INSERT_ASSET_SQL`
  semantics (model_used/price/provider round-trip; dedup by source_id).
- Fakes (`test_seed_pd12m.py`): `seed_from_parquet_fast` dedups + batch-embeds + writes.
- Integration: finish the last ~25.4k rows on prod (live validation), then it is the
  default for future batches.

## Expected result

~230 ms/row → well under ~10 ms/row amortized; 250k in minutes, not hours.
