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
    out = c.pending_queries(10)
    assert out == [QueryRow("a fox", "A Fox", 5)]
    sql, params = calls[0]
    assert "status='pending'" in sql and "ORDER BY count DESC" in sql and params == [10]
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

def test_insert_asset_binds_all_columns(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    rec = AssetRecord(id="i1", prompt="p", url="u", thumb_url=None, medium_url=None,
                      model_used="m", source="generated", source_id=None, content_hash="h",
                      width=1, height=2, mime="image/webp", manifest_url="mf", created_at="t",
                      source_url=None, locally_cached=True)
    c.insert_asset(rec)
    sql, params = calls[0]
    assert "INSERT INTO assets" in sql and "manifest_url" in sql
    assert params[0] == "i1" and 1 in params and "generated" in params and "mf" in params

def test_asset_exists(monkeypatch):
    c, calls = _client(monkeypatch, [[{"1": 1}], []])
    assert c.asset_exists("i1") is True
    assert c.asset_exists("i2") is False
    sql, params = calls[0]
    assert "FROM assets" in sql and params == ["i1"]

def test_assets_needing_rehost_maps(monkeypatch):
    rows = [[{"id": "i1", "prompt": "p", "source": "pd12m", "source_id": "7",
              "thumb_url": None, "medium_url": None, "url": "https://ext/x.jpg",
              "model_used": "clip-vit-l-14", "content_hash": "pd12m-7", "width": 10, "height": 20,
              "mime": "image/jpeg", "source_url": "https://ext/x.jpg", "locally_cached": 0}]]
    c, calls = _client(monkeypatch, rows)
    out = c.assets_needing_rehost(5)
    assert len(out) == 1 and out[0].id == "i1" and out[0].locally_cached is False
    assert out[0].source_url == "https://ext/x.jpg"
    assert "rehost_attempts < 5" in calls[0][0]  # failing sources stop starving the queue

def test_increment_rehost_attempts(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.increment_rehost_attempts("i1")
    sql, params = calls[0]
    assert "rehost_attempts=rehost_attempts+1" in sql and params == ["i1"]

def test_update_asset_urls_binds(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.update_asset_urls("i1", url="b/large", medium_url="b/med", thumb_url="b/thumb",
                        width=3, height=4, mime="image/webp", locally_cached=True)
    sql, params = calls[0]
    assert "UPDATE assets" in sql and "locally_cached" in sql
    assert params[-1] == "i1" and 1 in params  # locally_cached True -> 1

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
