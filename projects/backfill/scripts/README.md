# Backfill / seed operational scripts

All commands need a Cloudflare API token (**D1 Edit + Vectorize Edit**) in the
repo-root `.env` (`CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `CF_API_TOKEN`). Embeddings
run locally (BGE on CPU), so seeding is ~$0.

## Seed the library (batched, resilient) — the normal path

Drive the `pd12m` asset count up to an absolute target. Overshoot-proof and
dedup-safe: recomputes `remaining` from the live count each attempt, fast-forwards
past the already-seeded parquet prefix (`skip`), writes Vectorize-first (a crash
leaves only a benign orphan vector, never a search-invisible orphan D1 row), and
rebuilds the HTTP clients on an SSL `bad_record_mac`.

```bash
# one command; resumable — re-run with the same target to continue
uv run python -m wagmiphotos.backfill.seed_pd12m \
    --metadata-dir ~/data/PD12M/metadata --target 761505
```

To also survive **hard** process death (segfault / OOM / host restart), wrap it:

```bash
projects/backfill/scripts/seed_to_target.sh 761505
```

### Other seed modes (`seed_pd12m`)

| Flags | Behaviour |
|---|---|
| `--metadata-dir D --target N` | batched + resilient to absolute count `N` (above) |
| `--metadata-dir D --limit N --fast` | single batched pass, `N` new rows (`--skip`, `--page-size` optional) |
| `--metadata-dir D --limit N` | slow path: one D1 write per row (legacy) |
| `--limit N` (no `--metadata-dir`) | seed from the HF dataset-viewer |

## Reconcile orphan vectors

Find `pd12m` rows in D1 that are missing from Vectorize (legacy D1-first orphans)
and backfill their vectors. Idempotent + resumable.

```bash
uv run python -m wagmiphotos.backfill.reconcile_orphans          # dry-run (count)
uv run python -m wagmiphotos.backfill.reconcile_orphans --apply  # backfill
```
