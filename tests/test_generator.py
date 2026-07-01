import asyncio
import pytest
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage


@pytest.mark.asyncio
async def test_stub_generator_persists_bytes_and_returns_metadata():
    storage = InMemoryStorage()
    gen = StubGenerator(storage)
    out = await gen.generate("a red bicycle", model="gpt-image-1", size="1024x1024")
    assert out.source == "stub"
    assert out.width == 1024 and out.height == 1024
    assert out.manifest_hash and out.content_hash
    assert storage.get(out.storage_key)  # bytes were persisted


def test_stub_sets_model_used_and_source():
    g = asyncio.run(StubGenerator(InMemoryStorage()).generate(
        "p", model="shared-cache-gmicloud-flux", size="8x8"))
    assert g.model_used == "flux"
    assert g.source == "stub"


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
