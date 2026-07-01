import io, pytest
from PIL import Image
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.models import AssetRecord
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter
from sharedcache.generator import StubGenerator

def _jpeg():
    b = io.BytesIO(); Image.new("RGB", (200, 100), "blue").save(b, format="JPEG"); return b.getvalue()

def _seeded_service(monkeypatch, status=200, content=None):
    idx = InMemoryCacheIndex(); storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(8), idx, StubGenerator(storage), storage, CostMeter(),
                       created_at_fn=lambda: "t")
    rec = AssetRecord(id="lazy1", prompt="a red fox", url="https://ext/fox.jpg", thumb_url=None,
                      medium_url=None, model_used="pd12m-clip", source="pd12m", source_id="7",
                      content_hash="pd12m-7", width=200, height=100, mime="image/jpeg",
                      manifest_url=None, created_at="t", source_url="https://ext/fox.jpg",
                      locally_cached=False)
    idx.insert(rec, HashEmbedder(8).embed("a red fox"))

    class FakeResp:
        def __init__(self, c, s): self.content, self.status_code = c, s
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, **kw): return FakeResp(content, status)
    import httpx; monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: FakeClient())
    return svc, idx, rec

@pytest.mark.asyncio
async def test_lazy_rehost_writes_three_sizes(monkeypatch):
    svc, idx, rec = _seeded_service(monkeypatch, content=_jpeg())
    r = await svc.generate("a red fox", cache_tolerance=0.5)
    assert r.result == "hit"
    assert rec.locally_cached is True
    assert rec.url.endswith("image.webp") and rec.medium_url.endswith("medium.webp") \
        and rec.thumb_url.endswith("thumb.webp")

@pytest.mark.asyncio
async def test_lazy_rehost_download_failure_is_graceful(monkeypatch):
    svc, idx, rec = _seeded_service(monkeypatch, status=500, content=b"")
    r = await svc.generate("a red fox", cache_tolerance=0.5)
    assert r.result == "hit"                 # still returns the asset
    assert rec.locally_cached is False        # rehost did not complete
    assert rec.url == "https://ext/fox.jpg"   # original url preserved
