from fastapi.testclient import TestClient
from sharedcache.api import build_app
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter

def _client():
    storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(64), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    return TestClient(build_app(svc, api_key="secret"))

def test_requires_api_key():
    r = _client().post("/v1/images/generations", json={"prompt": "x"})
    assert r.status_code == 401

def test_miss_then_hit_shape():
    c = _client()
    h = {"Authorization": "Bearer secret"}
    r1 = c.post("/v1/images/generations", json={"prompt": "a cat", "model": "image-cache-1"}, headers=h)
    assert r1.status_code == 200
    assert r1.json()["shared_cache"]["result"] == "miss"
    assert r1.json()["data"][0]["url"]
    r2 = c.post("/v1/images/generations", json={"prompt": "a cat"}, headers=h)
    assert r2.json()["shared_cache"]["result"] == "hit"
    assert r2.json()["shared_cache"]["cost_saved_usd"] > 0

def test_healthz():
    assert _client().get("/healthz").json() == {"status": "ok"}

def test_n_greater_than_one_is_rejected():
    c = _client()
    r = c.post("/v1/images/generations",
               json={"prompt": "a cat", "n": 2},
               headers={"Authorization": "Bearer secret"})
    assert r.status_code == 422
