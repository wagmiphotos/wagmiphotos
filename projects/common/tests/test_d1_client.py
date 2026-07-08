from wagmiphotos.common.d1_client import D1Client, QueryRow
from wagmiphotos.common.models import AssetRecord

def _client(monkeypatch, rows=None):
    calls = []
    c = D1Client("acct", "db", "token")
    def fake_query(sql, params=None):
        calls.append((sql, params or []))
        return rows.pop(0) if rows else []
    monkeypatch.setattr(c, "_query", fake_query)
    return c, calls

def test_pending_queries_orders_and_maps(monkeypatch):
    rows = [[{"normalized_prompt": "a fox", "original_prompt": "A Fox", "count": 5}]]
    c, calls = _client(monkeypatch, rows)
    out = c.pending_queries(10, min_count=3)
    assert out == [QueryRow("a fox", "A Fox", 5)]
    sql, params = calls[0]
    assert "status='pending'" in sql and "ORDER BY count DESC" in sql and params == [3, 10]
    assert "count >= ?" in sql  # demand threshold: skip one-off prompts
    assert "generate=1" in sql  # opted-out prompts are never picked up by the backfill
    assert "attempts < 5" in sql  # poisoned prompts fall out of the queue
    assert "building" in sql and "-15 minutes" in sql  # stale claims are reclaimable

def test_claim_query_returns_true_only_when_one_row_changed(monkeypatch):
    c = D1Client("acct", "db", "token")
    changes = [1, 0]
    seen = []
    monkeypatch.setattr(c, "_changes", lambda sql, params=None: (seen.append((sql, params)), changes.pop(0))[1])
    assert c.claim_query("a fox") is True
    assert c.claim_query("a fox") is False
    sql, params = seen[0]
    assert "status='building'" in sql and "claimed_at=datetime('now')" in sql
    assert params == ["a fox"]

def test_release_query_claim_resets_status(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.release_query_claim("a fox")
    sql, params = calls[0]
    assert "status='pending'" in sql and "claimed_at=NULL" in sql and params == ["a fox"]

def test_mark_query_built_sends_update(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_query_built("a fox", "asset1", similarity=0.93)
    sql, params = calls[0]
    assert "UPDATE queries" in sql and "status='built'" in sql
    assert "claimed_at=NULL" in sql and "last_similarity" in sql
    assert params == ["asset1", 0.93, "a fox"]

def test_mark_query_built_similarity_defaults_to_none(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_query_built("a fox", "asset1")
    assert calls[0][1] == ["asset1", None, "a fox"]

def test_record_query_failure_resets_and_increments(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.record_query_failure("a fox", "boom")
    sql, params = calls[0]
    assert "status='pending'" in sql and "attempts=attempts+1" in sql
    assert "last_error=?" in sql and "claimed_at=NULL" in sql
    assert params == ["boom", "a fox"]

def test_deny_query_sets_generate_zero(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.deny_query("a pikachu", "denied: pikachu")
    sql, params = calls[0]
    assert "UPDATE queries SET generate=0" in sql and "last_error=?" in sql
    assert params == ["denied: pikachu", "a pikachu"]


def test_insert_asset_binds_all_columns(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    rec = AssetRecord(id="i1", prompt="p", model_used="m", source="generated", source_id=None,
                      content_hash="h", width=1, height=2, mime="image/webp", created_at="t",
                      source_url=None, locally_cached=True, price_usd=0.01, provider="gmicloud")
    c.insert_asset(rec)
    sql, params = calls[0]
    assert "INSERT INTO assets" in sql and "source_url" in sql
    assert params[0] == "i1" and 1 in params and "generated" in params
    columns = {c.strip() for c in sql.split("(", 1)[1].split(")", 1)[0].split(",")}
    # 0007: no stored-URL columns are bound (source_url is the only survivor)
    assert not (columns & {"url", "thumb_url", "medium_url", "manifest_url"})
    # 0009: per-image cost + provider are bound so the row is self-describing.
    assert {"price_usd", "provider"} <= columns
    assert 0.01 in params and "gmicloud" in params
    # model_used survives the slimming — the worker serves it (shared_cache
    # + library publicAsset), so inserts must keep populating it.
    assert "model_used" in columns and "m" in params

def test_asset_exists(monkeypatch):
    c, calls = _client(monkeypatch, [[{"1": 1}], []])
    assert c.asset_exists("i1") is True
    assert c.asset_exists("i2") is False
    sql, params = calls[0]
    assert "FROM live_assets" in sql and params == ["i1"]


def _rehost_row(id):
    return {"id": id, "prompt": "p", "source": "pd12m", "source_id": "7",
            "model_used": None, "content_hash": None, "width": 1, "height": 2,
            "mime": "image/jpeg", "source_url": "https://ext/x.jpg", "locally_cached": 0}

def test_assets_needing_rehost_demand_then_trickle(monkeypatch):
    c, calls = _client(monkeypatch, [[_rehost_row("hot")], [_rehost_row("cold")]])
    out = c.assets_needing_rehost(2)
    assert [a.id for a in out] == ["hot", "cold"]
    sql1, params1 = calls[0]
    assert "ORDER BY q.demand DESC" in sql1 and "live_assets" in sql1 and params1 == [2]
    sql2, params2 = calls[1]
    assert "NOT IN (?)" in sql2 and "live_assets" in sql2 and params2 == ["hot", 1]

def test_assets_needing_rehost_skips_trickle_when_demand_fills_batch(monkeypatch):
    c, calls = _client(monkeypatch, [[_rehost_row("h1"), _rehost_row("h2")]])
    out = c.assets_needing_rehost(2)
    assert [a.id for a in out] == ["h1", "h2"]
    assert len(calls) == 1                      # no trickle query issued

def test_increment_rehost_attempts_returns_new_count(monkeypatch):
    c, calls = _client(monkeypatch, [[{"rehost_attempts": 3}]])
    assert c.increment_rehost_attempts("i1") == 3
    sql, params = calls[0]
    assert "RETURNING rehost_attempts" in sql and params == ["i1"]

def test_increment_rehost_attempts_missing_row_returns_zero(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    assert c.increment_rehost_attempts("ghost") == 0

def test_mark_asset_rehosted_binds(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_asset_rehosted("i1", width=3, height=4, mime="image/webp")
    sql, params = calls[0]
    assert "UPDATE assets" in sql and "locally_cached=1" in sql
    assert params == [3, 4, "image/webp", "i1"]

def test_get_meta_returns_value_or_none(monkeypatch):
    c, calls = _client(monkeypatch, [[{"value": "0.12"}], []])
    assert c.get_meta("backfill_lifetime_spend_usd") == "0.12"
    assert c.get_meta("missing") is None
    assert "FROM meta" in calls[0][0]

def test_add_meta_float_upserts(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.add_meta_float("backfill_lifetime_spend_usd", 0.04)
    sql, params = calls[0]
    assert "INSERT INTO meta" in sql and "ON CONFLICT" in sql
    assert params == ["backfill_lifetime_spend_usd", "0.04"]

def test_existing_source_ids(monkeypatch):
    c, calls = _client(monkeypatch, [[{"source_id": "7"}]])
    out = c.existing_source_ids("pd12m", ["7", "8"])
    assert out == {"7"}
    sql, params = calls[0]
    assert "source_id IN (?,?)" in sql and params == ["pd12m", "7", "8"]

def test_existing_source_ids_empty_short_circuits(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    assert c.existing_source_ids("pd12m", []) == set()
    assert calls == []  # no round-trip for an empty batch

def test_existing_source_ids_chunks_under_d1_param_cap(monkeypatch):
    # D1 hard-caps bound parameters at 100 per statement; source + ids must
    # never exceed it (a 100-id seed page = 101 params = SQLITE_ERROR live).
    ids = [str(i) for i in range(150)]
    c, calls = _client(monkeypatch, [[{"source_id": "0"}], [{"source_id": "149"}]])
    out = c.existing_source_ids("pd12m", ids)
    assert out == {"0", "149"}                      # results merged across chunks
    assert len(calls) == 2
    for sql, params in calls:
        assert len(params) <= 100                   # source + <=99 ids
    assert [p for _, params in calls for p in params if p != "pd12m"] == ids  # all ids queried once

def test_mark_asset_dead_binds(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_asset_dead("a1", "http 404")
    sql, params = calls[0]
    assert "dead_at=datetime('now')" in sql and "dead_at IS NULL" in sql
    assert params == ["http 404", "a1"]
