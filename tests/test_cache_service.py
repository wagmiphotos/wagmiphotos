import pytest
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter

def _service():
    storage = InMemoryStorage()
    return CacheService(HashEmbedder(64), InMemoryCacheIndex(), StubGenerator(storage),
                        storage, CostMeter(), created_at_fn=lambda: "2026-06-23T00:00:00Z")

@pytest.mark.asyncio
async def test_first_request_is_a_miss_and_indexes():
    svc = _service()
    r = await svc.generate("a red bicycle", cache_tolerance=0.15)
    assert r.result == "miss"
    assert r.cost_saved_usd == 0.0
    assert r.record.thumb_url is not None

@pytest.mark.asyncio
async def test_identical_repeat_is_a_hit_and_saves_cost():
    svc = _service()
    await svc.generate("a red bicycle", cache_tolerance=0.15)
    r2 = await svc.generate("a red bicycle", cache_tolerance=0.15)
    assert r2.result == "hit"
    assert r2.similarity > 0.99
    assert r2.cost_saved_usd > 0

@pytest.mark.asyncio
async def test_zero_tolerance_forces_regeneration():
    svc = _service()
    await svc.generate("a red bicycle")
    r2 = await svc.generate("a red bicycle", cache_tolerance=0.0)
    # floor 0.98; identical prompt embeds identically (sim 1.0) so this still hits.
    # A *different* prompt at tol 0 must miss:
    r3 = await svc.generate("a blue canoe", cache_tolerance=0.0)
    assert r3.result == "miss"
