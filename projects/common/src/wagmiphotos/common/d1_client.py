from dataclasses import dataclass

import httpx

from wagmiphotos.common.cf_api import API_BASE, post_with_retry
from wagmiphotos.common.models import AssetRecord


@dataclass
class QueryRow:
    normalized_prompt: str
    original_prompt: str
    count: int


# Retry budgets: rows past these counts fall out of the work queues instead of
# stalling them (columns added in migration 0006).
MAX_QUERY_ATTEMPTS = 5
MAX_REHOST_ATTEMPTS = 5

# A 'building' claim older than this is considered abandoned and reclaimable.
CLAIM_TTL_SQL = "datetime('now','-15 minutes')"

_CLAIMABLE = ("(status='pending' OR (status='building' AND "
              f"claimed_at < {CLAIM_TTL_SQL}))")

# SQL is kept in module-level constants so tests can execute the exact strings
# against a sqlite database built from the real migrations (test_d1_migration).
PENDING_QUERIES_SQL = (
    "SELECT normalized_prompt, original_prompt, count FROM queries "
    f"WHERE {_CLAIMABLE} AND generate=1 AND attempts < {MAX_QUERY_ATTEMPTS} "
    "AND count >= ? ORDER BY count DESC LIMIT ?")

CLAIM_QUERY_SQL = (
    "UPDATE queries SET status='building', claimed_at=datetime('now') "
    f"WHERE normalized_prompt=? AND {_CLAIMABLE}")

RELEASE_CLAIM_SQL = (
    "UPDATE queries SET status='pending', claimed_at=NULL "
    "WHERE normalized_prompt=? AND status='building'")

MARK_QUERY_BUILT_SQL = (
    "UPDATE queries SET status='built', last_asset_id=?, "
    "last_similarity=COALESCE(?, last_similarity), claimed_at=NULL "
    "WHERE normalized_prompt=?")

RECORD_QUERY_FAILURE_SQL = (
    "UPDATE queries SET status='pending', claimed_at=NULL, attempts=attempts+1, "
    "last_error=? WHERE normalized_prompt=?")

INSERT_ASSET_SQL = (
    "INSERT INTO assets (id, prompt, source, source_id, model_used, content_hash, width, "
    "height, mime, source_url, locally_cached, price_usd, provider) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")

ASSET_EXISTS_SQL = "SELECT 1 FROM live_assets WHERE id=? LIMIT 1"

_REHOST_COLS = ("id, prompt, source, source_id, model_used, content_hash, width, height, "
                "mime, source_url, locally_cached")

# Demand-ranked rehost selection: start from the queries aggregate (one row per
# unique prompt — small), join into live assets; never scans the assets table.
DEMANDED_REHOSTS_SQL = (
    "SELECT " + ", ".join(f"a.{c.strip()}" for c in _REHOST_COLS.split(",")) + " FROM ("
    "SELECT last_asset_id AS id, SUM(count) AS demand FROM queries "
    "WHERE last_asset_id IS NOT NULL GROUP BY last_asset_id) q "
    "JOIN live_assets a ON a.id = q.id "
    f"WHERE a.locally_cached=0 AND a.rehost_attempts < {MAX_REHOST_ATTEMPTS} "
    "ORDER BY q.demand DESC LIMIT ?")


def trickle_rehosts_sql(n_exclude: int) -> str:
    """FIFO fallback for leftover batch slots; excludes already-picked ids."""
    exclude = f" AND id NOT IN ({','.join('?' * n_exclude)})" if n_exclude else ""
    return (f"SELECT {_REHOST_COLS} FROM live_assets "
            f"WHERE locally_cached=0 AND rehost_attempts < {MAX_REHOST_ATTEMPTS}"
            f"{exclude} LIMIT ?")


INCREMENT_REHOST_ATTEMPTS_SQL = (
    "UPDATE assets SET rehost_attempts=rehost_attempts+1 WHERE id=? "
    "RETURNING rehost_attempts")

MARK_ASSET_DEAD_SQL = (
    "UPDATE assets SET dead_at=datetime('now'), dead_reason=? "
    "WHERE id=? AND dead_at IS NULL")

MARK_ASSET_REHOSTED_SQL = (
    "UPDATE assets SET width=?, height=?, mime=?, locally_cached=1 WHERE id=?")

META_GET_SQL = "SELECT value FROM meta WHERE key=?"

META_ADD_SQL = (
    "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET "
    "value = CAST(CAST(value AS REAL) + CAST(excluded.value AS REAL) AS TEXT)")


def existing_source_ids_sql(n: int) -> str:
    placeholders = ",".join("?" * n)
    return f"SELECT source_id FROM assets WHERE source=? AND source_id IN ({placeholders})"


class D1Client:
    def __init__(self, account_id: str, database_id: str, api_token: str, timeout: float = 30.0):
        self._url = f"{API_BASE}/accounts/{account_id}/d1/database/{database_id}/query"
        self._headers = {"Authorization": f"Bearer {api_token}"}
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def _exec(self, sql: str, params: list | None = None) -> dict:
        """Run one statement; return D1's result[0] ({"results": [...], "meta": {...}})."""
        body = post_with_retry(self._client, self._url, what="D1 query",
                               headers=self._headers,
                               json={"sql": sql, "params": params or []})
        return body["result"][0]

    def _query(self, sql: str, params: list | None = None) -> list[dict]:
        return self._exec(sql, params).get("results", [])

    def _changes(self, sql: str, params: list | None = None) -> int:
        """Run one statement; return the affected-row count."""
        return int(self._exec(sql, params).get("meta", {}).get("changes", 0))

    def pending_queries(self, limit: int, min_count: int = 1) -> list[QueryRow]:
        rows = self._query(PENDING_QUERIES_SQL, [min_count, limit])
        return [QueryRow(r["normalized_prompt"], r["original_prompt"], int(r["count"])) for r in rows]

    def claim_query(self, normalized_prompt: str) -> bool:
        """Claim a query for building. True iff this worker won the claim."""
        return self._changes(CLAIM_QUERY_SQL, [normalized_prompt]) == 1

    def release_query_claim(self, normalized_prompt: str) -> None:
        """Return an unprocessed claim to the queue (no attempt is charged)."""
        self._query(RELEASE_CLAIM_SQL, [normalized_prompt])

    def mark_query_built(self, normalized_prompt: str, asset_id: str,
                         similarity: float | None = None) -> None:
        self._query(MARK_QUERY_BUILT_SQL, [asset_id, similarity, normalized_prompt])

    def record_query_failure(self, normalized_prompt: str, error: str) -> None:
        self._query(RECORD_QUERY_FAILURE_SQL, [error, normalized_prompt])

    def insert_asset(self, rec: AssetRecord) -> None:
        self._query(
            INSERT_ASSET_SQL,
            [rec.id, rec.prompt, rec.source, rec.source_id, rec.model_used, rec.content_hash,
             rec.width, rec.height, rec.mime, rec.source_url, 1 if rec.locally_cached else 0,
             rec.price_usd, rec.provider])

    def asset_exists(self, asset_id: str) -> bool:
        return bool(self._query(ASSET_EXISTS_SQL, [asset_id]))

    def assets_needing_rehost(self, limit: int) -> list[AssetRecord]:
        rows = self._query(DEMANDED_REHOSTS_SQL, [limit])
        if len(rows) < limit:
            picked = [r["id"] for r in rows]
            rows += self._query(trickle_rehosts_sql(len(picked)),
                                [*picked, limit - len(rows)])
        return [AssetRecord(
            id=r["id"], prompt=r["prompt"], model_used=r["model_used"], source=r["source"],
            source_id=r["source_id"], content_hash=r["content_hash"], width=r["width"],
            height=r["height"], mime=r["mime"], created_at="",
            source_url=r["source_url"], locally_cached=bool(r["locally_cached"])) for r in rows]

    def increment_rehost_attempts(self, asset_id: str) -> int:
        """Returns the post-increment attempt count (0 if the row is missing)."""
        rows = self._query(INCREMENT_REHOST_ATTEMPTS_SQL, [asset_id])
        return int(rows[0]["rehost_attempts"]) if rows else 0

    def mark_asset_dead(self, asset_id: str, reason: str) -> None:
        """Tombstone: idempotent, first reason wins (guarded by dead_at IS NULL)."""
        self._query(MARK_ASSET_DEAD_SQL, [reason, asset_id])

    def mark_asset_rehosted(self, asset_id: str, *, width: int, height: int, mime: str) -> None:
        self._query(MARK_ASSET_REHOSTED_SQL, [width, height, mime, asset_id])

    def get_meta(self, key: str) -> str | None:
        rows = self._query(META_GET_SQL, [key])
        return rows[0]["value"] if rows else None

    def add_meta_float(self, key: str, amount: float) -> None:
        """Atomically add `amount` to a numeric meta value (creates it if absent)."""
        self._query(META_ADD_SQL, [key, str(amount)])

    # D1 hard-caps bound parameters at 100 per statement; each chunk binds
    # source + up to 99 ids.
    _SOURCE_ID_CHUNK = 99

    def existing_source_ids(self, source: str, source_ids: list[str]) -> set[str]:
        """Which of `source_ids` already exist for `source` (seed dedupe).
        Chunked to stay under D1's 100-bound-parameter cap."""
        found: set[str] = set()
        for i in range(0, len(source_ids), self._SOURCE_ID_CHUNK):
            chunk = source_ids[i:i + self._SOURCE_ID_CHUNK]
            rows = self._query(existing_source_ids_sql(len(chunk)), [source, *chunk])
            found.update(r["source_id"] for r in rows)
        return found
