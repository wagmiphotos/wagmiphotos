import warnings
from fastapi.testclient import TestClient
from sharedcache.api import build_app, _build_from_settings
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex, PgCacheIndex
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage, GenblazeS3Storage
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


def test_provider_api_key_header_forwarding():
    storage = InMemoryStorage()
    generator = StubGenerator(storage)
    original_generate = generator.generate
    
    called_with_key = None
    async def spy_generate(prompt, *, model, size="1024x1024", provider_api_key=None):
        nonlocal called_with_key
        called_with_key = provider_api_key
        return await original_generate(prompt, model=model, size=size, provider_api_key=provider_api_key)
        
    generator.generate = spy_generate
    
    svc = CacheService(HashEmbedder(64), InMemoryCacheIndex(), generator,
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, api_key=None))
    
    r = client.post(
        "/v1/images/generations",
        json={"prompt": "xyz", "model": "shared-cache-openai-dall-e-3"},
        headers={"X-OpenAI-API-Key": "my-openai-secret-key"}
    )
    assert r.status_code == 200
    assert called_with_key == "my-openai-secret-key"


def test_key_as_identity_authorization():
    storage = InMemoryStorage()
    generator = StubGenerator(storage)
    original_generate = generator.generate
    
    called_with_key = None
    async def spy_generate(prompt, *, model, size="1024x1024", provider_api_key=None):
        nonlocal called_with_key
        called_with_key = provider_api_key
        return await original_generate(prompt, model=model, size=size, provider_api_key=provider_api_key)
        
    generator.generate = spy_generate
    
    # We configure a master API key "master-secret"
    svc = CacheService(HashEmbedder(64), InMemoryCacheIndex(), generator,
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, api_key="master-secret"))
    
    # 1. Invalid provider key should fail
    r1 = client.post(
        "/v1/images/generations",
        json={"prompt": "xyz", "model": "shared-cache-openai-dall-e-3"},
        headers={"Authorization": "Bearer bad-key"}
    )
    assert r1.status_code == 401
    
    # 2. Valid provider key format in Authorization header should pass
    r2 = client.post(
        "/v1/images/generations",
        json={"prompt": "xyz", "model": "shared-cache-openai-dall-e-3"},
        headers={"Authorization": "Bearer sk-proj-1234"}
    )
    assert r2.status_code == 200
    assert called_with_key == "sk-proj-1234"


def test_custom_generated_keys():
    storage = InMemoryStorage()
    generator = StubGenerator(storage)
    svc = CacheService(HashEmbedder(64), InMemoryCacheIndex(), generator,
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, api_key="master-secret"))
    
    # 1. Unregistered key should fail
    r1 = client.post(
        "/v1/images/generations",
        json={"prompt": "xyz", "model": "shared-cache-openai-dall-e-3"},
        headers={"Authorization": "Bearer sc-not-real"}
    )
    assert r1.status_code == 401
    
    # 2. Generate a key via the endpoint
    r2 = client.post("/v1/keys/generate")
    assert r2.status_code == 200
    new_key = r2.json()["key"]
    assert new_key.startswith("sc-")
    
    # 3. Presenting the new key in the header should pass
    r3 = client.post(
        "/v1/images/generations",
        json={"prompt": "xyz", "model": "shared-cache-openai-dall-e-3"},
        headers={"Authorization": f"Bearer {new_key}"}
    )
    assert r3.status_code == 200


# --- Coherent factory tests (FIX 2) ---

def test_empty_env_builds_in_memory_collaborators(monkeypatch):
    """With no env vars, _build_from_settings must use in-memory/stub adapters."""
    env_vars = [
        "OPENAI_API_KEY", "GEMINI_API_KEY",
        "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_REGION",
        "B2_PUBLIC_URL_BASE", "DATABASE_URL", "EMBEDDING_DIMS",
        "DEFAULT_IMAGE_MODEL", "API_KEY",
    ]
    for v in env_vars:
        monkeypatch.delenv(v, raising=False)
    # Override .env file resolution so no local .env is loaded
    monkeypatch.setenv("PYDANTIC_SETTINGS_ENV_FILE", "")

    # Patch Settings to avoid reading .env on disk during this test
    from sharedcache import config as _cfg_mod
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class _EmptySettings(_cfg_mod.Settings):
        model_config = SettingsConfigDict(env_file=None, extra="ignore")

    original_settings = _cfg_mod.Settings
    monkeypatch.setattr(_cfg_mod, "Settings", _EmptySettings)

    # Re-import api so it uses patched Settings
    import importlib
    import sharedcache.api as api_mod
    app = api_mod._build_from_settings()
    svc = app.state.service

    assert isinstance(svc._storage, InMemoryStorage), "expected InMemoryStorage with no B2 creds"
    assert isinstance(svc._index, InMemoryCacheIndex), "expected InMemoryCacheIndex with no DB URL"

    monkeypatch.setattr(_cfg_mod, "Settings", original_settings)


def test_database_url_without_b2_uses_in_memory_index_and_warns(monkeypatch):
    """DATABASE_URL set but no B2 creds → InMemoryCacheIndex + UserWarning (not PgCacheIndex)."""
    env_vars = [
        "OPENAI_API_KEY", "GEMINI_API_KEY",
        "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET",
        "B2_PUBLIC_URL_BASE", "API_KEY",
    ]
    for v in env_vars:
        monkeypatch.delenv(v, raising=False)

    from sharedcache import config as _cfg_mod
    from pydantic_settings import SettingsConfigDict

    class _DbOnlySettings(_cfg_mod.Settings):
        model_config = SettingsConfigDict(env_file=None, extra="ignore")
        database_url: str | None = "postgresql://localhost/sharedcache"

    original_settings = _cfg_mod.Settings
    monkeypatch.setattr(_cfg_mod, "Settings", _DbOnlySettings)

    import sharedcache.api as api_mod
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        app = api_mod._build_from_settings()

    svc = app.state.service
    assert isinstance(svc._storage, InMemoryStorage), "expected InMemoryStorage (no B2 creds)"
    assert isinstance(svc._index, InMemoryCacheIndex), "must NOT use PgCacheIndex when storage is ephemeral"
    assert not isinstance(svc._index, PgCacheIndex)

    warning_messages = [str(w.message) for w in caught if issubclass(w.category, UserWarning)]
    assert any("DATABASE_URL" in m and "in-memory" in m for m in warning_messages), (
        f"expected a UserWarning about falling back to in-memory index; got: {warning_messages}"
    )


def test_memory_route_serves_stored_bytes():
    from sharedcache.api import build_app
    from sharedcache.cache_service import CacheService
    from sharedcache.embedder import HashEmbedder
    from sharedcache.index import InMemoryCacheIndex
    from sharedcache.generator import StubGenerator
    from sharedcache.storage import InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from fastapi.testclient import TestClient

    storage = InMemoryStorage()
    storage.put("assets/x/image.webp", b"PNGBYTES", "image/webp")
    svc = CacheService(HashEmbedder(8), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, None))
    r = client.get("/memory/sharedcache/assets/x/image.webp")
    assert r.status_code == 200
    assert r.content == b"PNGBYTES"


def test_dev_key_is_not_a_backdoor(monkeypatch):
    # With an API_KEY configured, the literal "dev-key" must NOT authenticate.
    from sharedcache.api import build_app
    from sharedcache.cache_service import CacheService
    from sharedcache.embedder import HashEmbedder
    from sharedcache.index import InMemoryCacheIndex
    from sharedcache.generator import StubGenerator
    from sharedcache.storage import InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from fastapi.testclient import TestClient

    storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(8), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, api_key="real-secret"))
    r = client.post("/v1/images/generations",
                    json={"prompt": "hi"}, headers={"Authorization": "Bearer dev-key"})
    assert r.status_code == 401
