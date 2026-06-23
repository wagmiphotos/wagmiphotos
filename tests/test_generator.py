import pytest
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage


@pytest.mark.asyncio
async def test_stub_generator_persists_bytes_and_returns_metadata():
    storage = InMemoryStorage()
    gen = StubGenerator(storage)
    out = await gen.generate("a red bicycle", model="gpt-image-1", size="1024x1024")
    assert out.provider == "stub"
    assert out.width == 1024 and out.height == 1024
    assert out.manifest_hash and out.content_hash
    assert storage.get(out.storage_key)  # bytes were persisted
