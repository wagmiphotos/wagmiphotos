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


@pytest.mark.asyncio
async def test_stub_generator_parses_model_prefix():
    storage = InMemoryStorage()
    gen = StubGenerator(storage)
    out = await gen.generate("a red bicycle", model="shared-cache-google-imagen-3")
    assert out.provider == "google"
    assert out.model == "imagen-3"


@pytest.mark.asyncio
async def test_genblaze_generator_requires_key_for_google(monkeypatch):
    import sys
    from types import ModuleType
    
    mock_module = ModuleType("genblaze_google")
    class MockImagenProvider:
        def __init__(self, api_key):
            self.api_key = api_key
    mock_module.ImagenProvider = MockImagenProvider
    monkeypatch.setitem(sys.modules, "genblaze_google", mock_module)

    from sharedcache.generator import GenblazeGenerator
    gen = GenblazeGenerator(storage=None)
    with pytest.raises(ValueError) as exc:
        await gen.generate("test", model="shared-cache-google-imagen-3")
    assert "Google Gemini API Key is required" in str(exc.value)
