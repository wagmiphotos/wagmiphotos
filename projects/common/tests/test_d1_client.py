from sharedcache.common.d1_client import D1Client, QueryRow
from sharedcache.common.models import AssetRecord

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

def test_mark_query_built_sends_update(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_query_built("a fox", "asset1")
    sql, params = calls[0]
    assert "UPDATE queries" in sql and "status='built'" in sql
    assert params == ["asset1", "a fox"]

def test_insert_asset_binds_all_columns(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    rec = AssetRecord(id="i1", prompt="p", url="u", thumb_url=None, medium_url=None,
                      model_used="m", source="generated", source_id=None, content_hash="h",
                      width=1, height=2, mime="image/webp", manifest_url=None, created_at="t",
                      source_url=None, locally_cached=True)
    c.insert_asset(rec)
    sql, params = calls[0]
    assert "INSERT INTO assets" in sql
    assert params[0] == "i1" and 1 in params and "generated" in params

def test_assets_needing_rehost_maps(monkeypatch):
    rows = [[{"id": "i1", "prompt": "p", "source": "pd12m", "source_id": "7",
              "thumb_url": None, "medium_url": None, "url": "https://ext/x.jpg",
              "model_used": "clip-vit-l-14", "content_hash": "pd12m-7", "width": 10, "height": 20,
              "mime": "image/jpeg", "source_url": "https://ext/x.jpg", "locally_cached": 0}]]
    c, calls = _client(monkeypatch, rows)
    out = c.assets_needing_rehost(5)
    assert len(out) == 1 and out[0].id == "i1" and out[0].locally_cached is False
    assert out[0].source_url == "https://ext/x.jpg"

def test_update_asset_urls_binds(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.update_asset_urls("i1", url="b/large", medium_url="b/med", thumb_url="b/thumb",
                        width=3, height=4, mime="image/webp", locally_cached=True)
    sql, params = calls[0]
    assert "UPDATE assets" in sql and "locally_cached" in sql
    assert params[-1] == "i1" and 1 in params  # locally_cached True -> 1
