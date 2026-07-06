import asyncio
import pytest
from wagmiphotos.generation.generator import (
    GenblazeGenerator,
    StubGenerator,
    build_model_id,
    parse_model_id,
    resolve_provider,
)
from wagmiphotos.generation.storage import InMemoryStorage


def test_build_model_id():
    assert build_model_id("gmicloud", "gpt-image-1") == "wagmiphotos-gmicloud-gpt-image-1"


def test_parse_model_id_extracts_provider_and_inner_model():
    assert parse_model_id("wagmiphotos-openai-gpt-image-1") == ("openai", "gpt-image-1")
    assert parse_model_id("wagmiphotos-gmicloud-flux") == ("gmicloud", "flux")


def test_parse_model_id_roundtrips_build():
    assert parse_model_id(build_model_id("google", "imagen-3")) == ("google", "imagen-3")


def test_parse_model_id_passthrough_uses_default_provider():
    assert parse_model_id("gpt-image-1") == ("gmicloud", "gpt-image-1")
    assert parse_model_id("gpt-image-1", default_provider="openai") == ("openai", "gpt-image-1")


def test_parse_model_id_short_prefixed_string_passes_through():
    # "wagmiphotos-x" has no inner model; treat the whole string as the model
    assert parse_model_id("wagmiphotos-x") == ("gmicloud", "wagmiphotos-x")


def test_resolve_provider_unknown_provider():
    with pytest.raises(ValueError) as e:
        resolve_provider("acme", "key", model="wagmiphotos-acme-m1")
    assert "Unsupported provider" in str(e.value)


def test_resolve_provider_not_installed_names_model_and_package():
    # genblaze_google is intentionally not a dependency of this workspace
    with pytest.raises(ValueError) as e:
        resolve_provider("google", "key", model="wagmiphotos-google-imagen-3")
    msg = str(e.value)
    assert "not installed" in msg
    assert "google" in msg and "wagmiphotos-google-imagen-3" in msg
    assert "pip install" in msg


def test_resolve_provider_requires_api_key():
    with pytest.raises(ValueError) as e:
        resolve_provider("gmicloud", None, model="wagmiphotos-gmicloud-gpt-image-1")
    assert "GMICloud API Key is required" in str(e.value)


def test_resolve_provider_returns_installed_provider_instance():
    inst = resolve_provider("gmicloud", "k", model="wagmiphotos-gmicloud-gpt-image-1")
    assert type(inst).__name__ == "GMICloudImageProvider"


def test_genblaze_preflight_raises_for_missing_provider_package():
    gen = GenblazeGenerator(storage=None, gemini_api_key="k")
    with pytest.raises(ValueError) as e:
        gen.preflight("wagmiphotos-google-imagen-3")
    assert "not installed" in str(e.value)


def test_genblaze_preflight_passes_for_installed_provider():
    GenblazeGenerator(storage=None, gmicloud_api_key="k").preflight(
        "wagmiphotos-gmicloud-gpt-image-1")


def test_genblaze_preflight_raises_for_missing_key():
    gen = GenblazeGenerator(storage=None)
    with pytest.raises(ValueError) as e:
        gen.preflight("wagmiphotos-gmicloud-gpt-image-1")
    assert "GMICloud API Key is required" in str(e.value)


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
        "p", model="wagmiphotos-gmicloud-flux", size="8x8"))
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

    gen = GenblazeGenerator(storage=None)
    with pytest.raises(ValueError) as exc:
        await gen.generate("test", model="wagmiphotos-google-imagen-3")
    assert "Google Gemini API Key is required" in str(exc.value)
