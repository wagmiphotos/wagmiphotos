"""Apply ALL D1 migrations (0001..000N) to sqlite, then run the real
D1Client SQL strings against the resulting schema so client/schema drift
fails loudly instead of at runtime against production D1."""
import pathlib
import sqlite3

import pytest

from wagmiphotos.common import d1_client

MIGRATIONS_DIR = (pathlib.Path(__file__).resolve().parents[3]
                  / "projects" / "worker" / "migrations")
MIGRATIONS = sorted(MIGRATIONS_DIR.glob("*.sql"))


@pytest.fixture()
def conn():
    conn = sqlite3.connect(":memory:")
    for path in MIGRATIONS:
        conn.executescript(path.read_text())
    yield conn
    conn.close()


def test_all_migrations_applied_in_order():
    assert [p.name[:4] for p in MIGRATIONS] == [f"{i:04d}" for i in range(1, len(MIGRATIONS) + 1)]
    assert len(MIGRATIONS) >= 7  # 0007 drops the stored-URL columns (derived URLs)


def test_migrations_create_tables_and_columns(conn):
    cols = {t: {r[1] for r in conn.execute(f"PRAGMA table_info({t})")}
            for t in ("assets", "queries", "api_keys", "meta")}
    assert {"id", "prompt", "source", "source_id", "model_used", "content_hash", "width",
            "height", "mime", "source_url", "locally_cached", "created_at",
            "rehost_attempts", "dead_at", "dead_reason", "price_usd", "provider"} <= cols["assets"]
    # 0007: URLs are derived from (id, locally_cached, source_url) — no longer stored.
    assert not ({"thumb_url", "medium_url", "url", "manifest_url"} & cols["assets"])
    # 0009: the live_assets view was recreated (0008's SELECT * must re-expand)
    # so the new columns are visible through the read path, not just the base table.
    live_cols = {r[1] for r in conn.execute("PRAGMA table_info(live_assets)")}
    assert {"price_usd", "provider"} <= live_cols
    assert {"normalized_prompt", "original_prompt", "count", "status", "last_asset_id",
            "last_similarity", "first_seen", "last_seen", "generate", "attempts",
            "last_error", "claimed_at"} <= cols["queries"]
    assert {"key_hash", "created_at"} <= cols["api_keys"]
    assert {"key", "value"} <= cols["meta"]
    idx = {r[1] for r in conn.execute("PRAGMA index_list(queries)")}
    assert any("pending_generate_count" in name for name in idx)


def _seed_query(conn, prompt="a fox", **overrides):
    row = {"normalized_prompt": prompt, "original_prompt": prompt.title(), "count": 3,
           "status": "pending", "generate": 1, "attempts": 0, "claimed_at": None}
    row.update(overrides)
    conn.execute(
        "INSERT INTO queries (normalized_prompt, original_prompt, count, status, generate, "
        "attempts, claimed_at) VALUES (?,?,?,?,?,?,?)",
        [row["normalized_prompt"], row["original_prompt"], row["count"], row["status"],
         row["generate"], row["attempts"], row["claimed_at"]])


def _seed_uncached_asset(conn, asset_id):
    params = list(ASSET_PARAMS)
    params[0] = asset_id
    params[LOCALLY_CACHED_IDX] = 0
    conn.execute(d1_client.INSERT_ASSET_SQL, params)


def _seed_demand(conn, prompt, asset_id, count):
    _seed_query(conn, prompt, count=count)
    conn.execute("UPDATE queries SET last_asset_id=? WHERE normalized_prompt=?",
                 [asset_id, prompt])


ASSET_PARAMS = ["a1", "a fox", "generated", None, "gpt-image-1", "hash", 1024, 1024,
                "image/webp", None, 1, 0.01, "gmicloud"]
LOCALLY_CACHED_IDX = 10  # position of locally_cached in ASSET_PARAMS


def test_pending_queries_sql_selects_and_filters(conn):
    _seed_query(conn, "a fox")
    _seed_query(conn, "worn out", attempts=5)                    # over the retry budget
    _seed_query(conn, "opted out", generate=0)                    # generate filter preserved
    _seed_query(conn, "already built", status="built")
    _seed_query(conn, "stale claim", status="building",
                claimed_at="2000-01-01 00:00:00")                 # reclaimable
    _seed_query(conn, "fresh claim", status="building",
                claimed_at=conn.execute("SELECT datetime('now')").fetchone()[0])
    rows = conn.execute(d1_client.PENDING_QUERIES_SQL, [10]).fetchall()
    got = {r[0] for r in rows}
    assert got == {"a fox", "stale claim"}


def test_claim_sql_claims_once_and_reclaims_stale(conn):
    _seed_query(conn, "a fox")
    cur = conn.execute(d1_client.CLAIM_QUERY_SQL, ["a fox"])
    assert cur.rowcount == 1                                      # first claim wins
    cur = conn.execute(d1_client.CLAIM_QUERY_SQL, ["a fox"])
    assert cur.rowcount == 0                                      # already claimed
    conn.execute("UPDATE queries SET claimed_at=datetime('now','-16 minutes') "
                 "WHERE normalized_prompt='a fox'")
    cur = conn.execute(d1_client.CLAIM_QUERY_SQL, ["a fox"])
    assert cur.rowcount == 1                                      # stale claim reclaimable


def test_release_claim_sql(conn):
    _seed_query(conn, "a fox")
    conn.execute(d1_client.CLAIM_QUERY_SQL, ["a fox"])
    conn.execute(d1_client.RELEASE_CLAIM_SQL, ["a fox"])
    status, claimed = conn.execute(
        "SELECT status, claimed_at FROM queries WHERE normalized_prompt='a fox'").fetchone()
    assert status == "pending" and claimed is None


def test_mark_built_sql_sets_status_similarity_and_clears_claim(conn):
    _seed_query(conn, "a fox")
    conn.execute(d1_client.CLAIM_QUERY_SQL, ["a fox"])
    conn.execute(d1_client.MARK_QUERY_BUILT_SQL, ["a1", 0.93, "a fox"])
    row = conn.execute("SELECT status, last_asset_id, last_similarity, claimed_at "
                       "FROM queries WHERE normalized_prompt='a fox'").fetchone()
    assert row == ("built", "a1", 0.93, None)


def test_mark_built_sql_keeps_similarity_when_none(conn):
    _seed_query(conn, "a fox")
    conn.execute("UPDATE queries SET last_similarity=0.5 WHERE normalized_prompt='a fox'")
    conn.execute(d1_client.MARK_QUERY_BUILT_SQL, ["a1", None, "a fox"])
    assert conn.execute("SELECT last_similarity FROM queries").fetchone()[0] == 0.5


def test_record_failure_sql_resets_and_counts(conn):
    _seed_query(conn, "a fox")
    conn.execute(d1_client.CLAIM_QUERY_SQL, ["a fox"])
    conn.execute(d1_client.RECORD_QUERY_FAILURE_SQL, ["boom", "a fox"])
    row = conn.execute("SELECT status, claimed_at, attempts, last_error FROM queries "
                       "WHERE normalized_prompt='a fox'").fetchone()
    assert row == ("pending", None, 1, "boom")


def test_insert_asset_and_asset_exists_sql(conn):
    conn.execute(d1_client.INSERT_ASSET_SQL, ASSET_PARAMS)
    assert conn.execute(d1_client.ASSET_EXISTS_SQL, ["a1"]).fetchall()
    assert not conn.execute(d1_client.ASSET_EXISTS_SQL, ["missing"]).fetchall()
    # model_used round-trips: the worker serves it (shared_cache.model_used,
    # library publicAsset), so slim inserts must still populate it.
    row = conn.execute("SELECT source, locally_cached, model_used FROM assets "
                       "WHERE id='a1'").fetchone()
    assert row == ("generated", 1, "gpt-image-1")
    # 0009: per-image price + provider round-trip through the slim insert.
    assert conn.execute("SELECT price_usd, provider FROM assets WHERE id='a1'"
                        ).fetchone() == (0.01, "gmicloud")


def test_old_insert_asset_sql_with_url_fails_after_0007(conn):
    """The pre-0007 INSERT (writing thumb_url/medium_url/url/manifest_url) must
    fail against the post-migration schema — those columns are gone."""
    old_sql = ("INSERT INTO assets (id, prompt, source, source_id, thumb_url, medium_url, url, "
               "model_used, content_hash, width, height, mime, source_url, locally_cached, "
               "manifest_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    with pytest.raises(sqlite3.OperationalError):
        conn.execute(old_sql, ["a1", "a fox", "generated", None, None, None, "l.webp",
                               "gpt-image-1", "hash", 1024, 1024, "image/webp", None, 1, "man.json"])


def test_rehost_sql_filters_attempts_and_increments(conn):
    _seed_uncached_asset(conn, "a1")
    rows = conn.execute(d1_client.trickle_rehosts_sql(0), [5]).fetchall()
    assert len(rows) == 1
    for i in range(5):
        n = conn.execute(d1_client.INCREMENT_REHOST_ATTEMPTS_SQL, ["a1"]).fetchone()[0]
        assert n == i + 1                    # RETURNING reports the new count
    assert conn.execute(d1_client.trickle_rehosts_sql(0), [5]).fetchall() == []


def test_mark_asset_rehosted_sql(conn):
    params = list(ASSET_PARAMS)
    params[LOCALLY_CACHED_IDX] = 0
    conn.execute(d1_client.INSERT_ASSET_SQL, params)
    conn.execute(d1_client.MARK_ASSET_REHOSTED_SQL, [512, 512, "image/webp", "a1"])
    row = conn.execute("SELECT width, height, mime, locally_cached FROM assets "
                       "WHERE id='a1'").fetchone()
    assert row == (512, 512, "image/webp", 1)


def test_meta_add_sql_accumulates_float(conn):
    conn.execute(d1_client.META_ADD_SQL, ["backfill_lifetime_spend_usd", "0.04"])
    conn.execute(d1_client.META_ADD_SQL, ["backfill_lifetime_spend_usd", "0.04"])
    value = conn.execute(d1_client.META_GET_SQL, ["backfill_lifetime_spend_usd"]).fetchone()[0]
    assert abs(float(value) - 0.08) < 1e-9


def test_existing_source_ids_sql(conn):
    params = list(ASSET_PARAMS)
    params[2], params[3] = "pd12m", "7"
    conn.execute(d1_client.INSERT_ASSET_SQL, params)
    sql = d1_client.existing_source_ids_sql(2)
    rows = conn.execute(sql, ["pd12m", "7", "8"]).fetchall()
    assert [r[0] for r in rows] == ["7"]


def test_0008_view_and_index(conn):
    views = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='view'")}
    assert "live_assets" in views
    idx = {r[1] for r in conn.execute("PRAGMA index_list(assets)")}
    assert any("rehostable" in name for name in idx)
    # the view filters dead rows and exposes the same columns as assets
    conn.execute(d1_client.INSERT_ASSET_SQL, ASSET_PARAMS)
    assert conn.execute("SELECT id FROM live_assets").fetchall() == [("a1",)]
    conn.execute("UPDATE assets SET dead_at=datetime('now') WHERE id='a1'")
    assert conn.execute("SELECT id FROM live_assets").fetchall() == []


def test_demanded_rehosts_orders_by_summed_count(conn):
    for aid in ("cold", "warm", "hot"):
        _seed_uncached_asset(conn, aid)
    _seed_demand(conn, "p1", "hot", 9)
    _seed_demand(conn, "p2", "hot", 4)       # SUM(hot)=13
    _seed_demand(conn, "p3", "warm", 5)
    rows = conn.execute(d1_client.DEMANDED_REHOSTS_SQL, [5]).fetchall()
    assert [r[0] for r in rows] == ["hot", "warm"]   # demand DESC; cold has none


def test_trickle_sql_excludes_picked_ids(conn):
    _seed_uncached_asset(conn, "a")
    _seed_uncached_asset(conn, "b")
    rows = conn.execute(d1_client.trickle_rehosts_sql(1), ["a", 5]).fetchall()
    assert [r[0] for r in rows] == ["b"]


def test_dead_assets_excluded_everywhere(conn):
    _seed_uncached_asset(conn, "a1")
    _seed_demand(conn, "p1", "a1", 5)
    conn.execute(d1_client.MARK_ASSET_DEAD_SQL, ["http 404", "a1"])
    assert conn.execute(d1_client.DEMANDED_REHOSTS_SQL, [5]).fetchall() == []
    assert conn.execute(d1_client.trickle_rehosts_sql(0), [5]).fetchall() == []
    assert conn.execute(d1_client.ASSET_EXISTS_SQL, ["a1"]).fetchall() == []
    dead_at, reason = conn.execute(
        "SELECT dead_at, dead_reason FROM assets WHERE id='a1'").fetchone()
    assert dead_at is not None and reason == "http 404"


def test_mark_asset_dead_idempotent_first_reason_wins(conn):
    _seed_uncached_asset(conn, "a1")
    conn.execute(d1_client.MARK_ASSET_DEAD_SQL, ["http 404", "a1"])
    conn.execute(d1_client.MARK_ASSET_DEAD_SQL, ["retries exhausted", "a1"])
    assert conn.execute(
        "SELECT dead_reason FROM assets WHERE id='a1'").fetchone()[0] == "http 404"
