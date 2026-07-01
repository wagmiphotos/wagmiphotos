import io
import pytest
from PIL import Image
from datetime import datetime, timezone

from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.models import AssetRecord
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter
from sharedcache.generator import StubGenerator

# Helper to generate valid dummy image bytes for Pillow processing
def get_dummy_image_bytes():
    img = Image.new("RGB", (200, 100), color="blue")
    out = io.BytesIO()
    img.save(out, format="JPEG")
    return out.getvalue()

class MockAsyncResponse:
    def __init__(self, content, status_code):
        self.content = content
        self.status_code = status_code

@pytest.mark.asyncio
async def test_lazy_caching_hit_downloads_and_updates(monkeypatch):
    # 1. Setup collaborators
    embedder = HashEmbedder(dims=8)
    index = InMemoryCacheIndex()
    storage = InMemoryStorage()
    generator = StubGenerator(storage)
    cost = CostMeter()
    
    # 2. Add an asset record with locally_cached = False
    asset_id = "test-lazy-id"
    prompt = "a cute red fox"
    external_url = "https://spawning.ai/images/fox.jpg"
    
    record = AssetRecord(
        id=asset_id,
        prompt=prompt,
        url=external_url,
        thumb_url=None,
        provider="public-domain",
        model="pd12m-clip",
        content_hash="pd12m-0",
        width=1000,
        height=1000,
        mime="image/jpeg",
        manifest_url=None,
        created_at=datetime.now(timezone.utc).isoformat(),
        source_url=external_url,
        locally_cached=False
    )
    
    # Insert with the corresponding embedding
    prompt_embedding = embedder.embed(prompt)
    index.insert(record, prompt_embedding)
    
    # 3. Mock HTTP download
    dummy_bytes = get_dummy_image_bytes()
    download_called = False
    
    class MockAsyncClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass
        async def get(self, url, follow_redirects=True, timeout=None):
            nonlocal download_called
            download_called = True
            assert url == external_url
            return MockAsyncResponse(dummy_bytes, 200)

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)
    
    # 4. Execute CacheService generate
    service = CacheService(
        embedder, index, generator, storage, cost,
        created_at_fn=lambda: datetime.now(timezone.utc).isoformat()
    )
    
    result = await service.generate(prompt, cache_tolerance=0.1)
    
    # 5. Assertions
    assert result.result == "hit"
    assert download_called is True
    
    # The record should now be updated to be locally cached
    assert result.record.locally_cached is True
    
    # The URL should have changed to point to the local storage memory:// path
    assert result.record.url.startswith("memory://sharedcache/assets/test-lazy-id/image.webp")
    assert result.record.thumb_url.startswith("memory://sharedcache/assets/test-lazy-id/thumb.webp")
    assert result.record.width == 200
    assert result.record.height == 100
    
    # Check storage was actually written
    assert storage.get("assets/test-lazy-id/image.webp") is not None
    assert storage.get("assets/test-lazy-id/thumb.webp") is not None
