from sharedcache.index import InMemoryCacheIndex
from sharedcache.models import AssetRecord

def _rec(id):
    return AssetRecord(id=id, prompt=id, url=f"u/{id}", thumb_url=None, medium_url=None,
                       model_used="m", source="generated", source_id=None, content_hash=id,
                       width=1, height=1, mime="image/webp", manifest_url=None, created_at="t")

def test_search_empty_returns_nothing():
    assert InMemoryCacheIndex().search([1.0, 0.0]) == []

def test_search_ranks_by_cosine_similarity():
    idx = InMemoryCacheIndex()
    idx.insert(_rec("near"), [1.0, 0.0])
    idx.insert(_rec("far"), [0.0, 1.0])
    results = idx.search([0.9, 0.1], k=2)
    assert results[0][0].id == "near"
    assert results[0][1] > results[1][1]

def test_api_keys_are_stored_hashed():
    from sharedcache.index import InMemoryCacheIndex
    idx = InMemoryCacheIndex()
    idx.add_api_key("sc-secret")
    # the raw key must not be stored; verification hashes the input
    assert "sc-secret" not in idx._api_keys
    assert idx.verify_api_key("sc-secret") is True
    assert idx.verify_api_key("sc-wrong") is False
