# Final Review Fixes Report

Branch: `feat/mvp`  
Date: 2026-06-23

---

## FIX 1 — Public B2 URL delivery

### Introspection result: does `get_durable_url` honor `public_url_base`?

**YES.** Source inspection of `S3StorageBackend.get_durable_url` confirms it returns `f"{self._public_url_base}/{encoded}"` when `public_url_base` is configured. `get_url` with `URLPolicy.AUTO` (the default) also returns the public URL when `public_url_base` is set. This means `GenblazeS3Storage.put` (which calls `self.backend.get_url(key)`) will already return the correct public URL — no override of `get_url` in our wrapper is needed. The durable URL written into `asset.url` will also be the public URL once the backend is configured.

### Changes made

- `src/sharedcache/config.py`: added `b2_public_url_base: str | None = None`
- `src/sharedcache/storage.py`: `GenblazeS3Storage.__init__` gains `public_url_base: str | None = None` forwarded to `S3StorageBackend.for_backblaze(..., public_url_base=public_url_base)`
- `src/sharedcache/api.py` `_build_from_settings`: passes `public_url_base=s.b2_public_url_base` when constructing `GenblazeS3Storage`
- `.env.example`: added `B2_PUBLIC_URL_BASE=` with comment explaining it is the public file URL base for a public-read B2 bucket
- `README.md`: B2 section and live-smoke section updated to require a public-read bucket and `B2_PUBLIC_URL_BASE`

### Operator live-verification required

- Make the B2 bucket public-read in the Backblaze console.
- Set `B2_PUBLIC_URL_BASE=https://f004.backblazeb2.com/file/<bucket-name>` in `.env`.
- Run `seed.py` and confirm `data[0].url` in the API response resolves to a 200 in the browser.
- Note: presigning (`URLPolicy.PRESIGNED`) is a future alternative for private buckets.

---

## FIX 2 — Coherent settings factory

### Problem

`DATABASE_URL` set + no B2 credentials would produce `PgCacheIndex` (durable) over `InMemoryStorage` (ephemeral), persisting `memory://` URLs that can never be retrieved after a restart.

### Changes made

- `src/sharedcache/api.py` `_build_from_settings`:
  - Builds `storage` first, then computes `using_durable_storage = isinstance(storage, GenblazeS3Storage)`.
  - Uses `PgCacheIndex` only when `s.database_url AND using_durable_storage`.
  - When `database_url` is set but storage is not durable, emits a `UserWarning` explaining the fallback and falls through to `InMemoryCacheIndex`.
- `tests/test_api.py`: two new offline tests added:
  - `test_empty_env_builds_in_memory_collaborators`: asserts that with no env vars, both `_storage` and `_index` are in-memory types.
  - `test_database_url_without_b2_uses_in_memory_index_and_warns`: asserts `DATABASE_URL`-only config does NOT produce `PgCacheIndex` and emits a `UserWarning` mentioning "DATABASE_URL" and "in-memory".

### Operator live-verification required

- None beyond the normal full-stack smoke test. The coherence rule is purely logic-gated.

---

## FIX 3 — Embedding dims / schema coherence

### Changes made

- `scripts/migrate.sql`: `vector(768)` replaced with `vector(__EMBEDDING_DIMS__)` (a placeholder).
- `scripts/migrate.py` (new): loads `migrate.sql`, substitutes `__EMBEDDING_DIMS__` with `Settings().embedding_dims`, prints resulting SQL to stdout. Does not require a DB connection.
- `README.md`: quickstart updated to use `uv run python scripts/migrate.py | psql "$DATABASE_URL"` instead of applying the raw `.sql`. Live-smoke section likewise updated.

### Offline verification

```
uv run python scripts/migrate.py          → embedding vector(768) NOT NULL
EMBEDDING_DIMS=3072 uv run python scripts/migrate.py  → embedding vector(3072) NOT NULL
```
Both confirmed correct.

### Operator live-verification required

- Run `uv run python scripts/migrate.py | psql "$DATABASE_URL"` with the intended `EMBEDDING_DIMS` value before inserting any rows.
- If you already have a schema with `vector(768)` and want to change dims, you must `DROP TABLE assets CASCADE` and re-migrate (pgvector does not support `ALTER COLUMN` to change vector dimensions).

---

## FIX 4 — README quickstart polish

### Changes made

- Removed the redundant `uv pip install -e .` step from the quickstart. Verified that `uv sync` installs the package as editable (creates `_editable_impl_sharedcache.pth` + `sharedcache-0.1.0.dist-info` in `.venv`), confirmed `uv run python scripts/seed.py` works without a separate editable install.
- Reordered the quickstart: install → configure → migrate → seed → start server → open UI. Seeding now clearly precedes the server start and is noted as standalone (does not depend on the running server).

---

## Verification commands and output

```bash
# migrate.py dims
uv run python scripts/migrate.py | grep vector
# → embedding vector(768) NOT NULL

EMBEDDING_DIMS=3072 uv run python scripts/migrate.py | grep vector
# → embedding vector(3072) NOT NULL

# app boot
uv run python -c "import sharedcache.api; print('import OK')"
# → import OK

# seed standalone
uv run python scripts/seed.py
# → miss  a cozy cafe interior
# → miss  a modern dental clinic
# → ...  (6 misses, all offline via StubGenerator)

# full suite
uv run pytest -q
# → 33 passed, 1 skipped, 1 warning  (was 31 before; +2 new FIX 2 tests)
```

---

## Summary of what still needs operator live-verification

1. **B2 public URL delivery**: bucket must be made public-read; `B2_PUBLIC_URL_BASE` must be set; verify `data[0].url` resolves in the browser (200, not 403).
2. **PgCacheIndex + B2 together**: with all credentials set, confirm first miss inserts a row into `assets` with the correct `vector(768)` embedding and a valid `https://` URL (not `memory://`).
3. **migrate.py with live DB**: run the piped migration against a real PostgreSQL+pgvector instance and confirm `\d assets` shows `vector(<EMBEDDING_DIMS>)`.
