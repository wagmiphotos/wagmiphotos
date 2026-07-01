import time
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sharedcache.cache_service import CacheService

class GenRequest(BaseModel):
    prompt: str
    model: str = "image-cache-1"
    n: int = 1
    size: str = "1024x1024"
    cache_tolerance: float = 0.15

def build_app(service: CacheService, api_key: str | None) -> FastAPI:
    app = FastAPI(title="WagmiPhotos")

    def _check(auth: str | None, provider_name: str) -> str:
        if not auth or not auth.startswith("Bearer "):
            if api_key is None:
                return ""
            raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
        
        token = auth.split("Bearer ", 1)[1].strip()
        if api_key is not None and token == api_key:
            return ""
            
        # Check database registered keys
        if service._index.verify_api_key(token):
            return ""
            
        # Fallback to key-format checking (for BYOK backward compatibility)
        if provider_name == "openai":
            if token.startswith("sk-") or token.startswith("sk-proj-"):
                return token
        elif provider_name == "google":
            if token.startswith("AIzaSy"):
                return token
        elif provider_name == "gmicloud":
            if token.startswith("gmi-"):
                return token
                
        raise HTTPException(status_code=401, detail="Invalid API Key")

    from fastapi.responses import FileResponse
    import os

    @app.get("/")
    @app.get("/playground")
    @app.get("/pricing")
    @app.get("/account")
    @app.get("/legal")
    def index():
        path = os.path.join(os.path.dirname(__file__), "..", "..", "web", "index.html")
        return FileResponse(os.path.abspath(path))

    from fastapi import Response
    @app.get("/memory/sharedcache/{key:path}")
    def get_memory_blob(key: str):
        try:
            data = service.storage.get(key)
            return Response(content=data, media_type="image/png")
        except Exception:
            raise HTTPException(status_code=404, detail="Blob not found in memory storage")

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/v1/keys/generate")
    def generate_api_key():
        import secrets
        new_key = f"sc-{secrets.token_urlsafe(24)}"
        try:
            service._index.add_api_key(new_key)
            import time
            return {"key": new_key, "created_at": time.time()}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate API Key: {e}")

    @app.post("/v1/images/generations")
    async def generate(
        body: GenRequest,
        authorization: str | None = Header(default=None),
        x_provider_api_key: str | None = Header(default=None),
        x_openai_api_key: str | None = Header(default=None),
        x_gemini_api_key: str | None = Header(default=None),
        x_gmicloud_api_key: str | None = Header(default=None),
    ):
        model_id = body.model
        if model_id == "image-cache-1":
            model_id = "shared-cache-openai-gpt-image-1"

        # Determine provider name from model prefix
        provider_name = "openai"
        if model_id.startswith("shared-cache-"):
            parts = model_id.split("-")
            if len(parts) >= 4:
                provider_name = parts[2]

        # Authenticate and resolve provider key
        resolved_key = _check(authorization, provider_name)
        if body.n != 1:
            raise HTTPException(status_code=422, detail="only n=1 is supported")

        # Resolve provider key (with header override fallback)
        provider_key = resolved_key or x_provider_api_key
        if provider_name == "openai":
            provider_key = provider_key or x_openai_api_key
        elif provider_name == "google":
            provider_key = provider_key or x_gemini_api_key
        elif provider_name == "gmicloud":
            provider_key = provider_key or x_gmicloud_api_key

        # Calculate a unique caller hash for tracking savings
        import hashlib
        caller_hash = "master"
        if provider_key:
            caller_hash = hashlib.sha256(provider_key.encode()).hexdigest()[:16]

        r = await service.generate(
            body.prompt,
            cache_tolerance=body.cache_tolerance,
            size=body.size,
            api_key=caller_hash,
            model=model_id,
            provider_api_key=provider_key
        )
        return JSONResponse({
            "created": int(time.time()),
            "data": [{"url": r.record.url}],
            "shared_cache": {
                "result": r.result,
                "similarity": r.similarity,
                "cost_saved_usd": r.cost_saved_usd,
                "provider": r.record.provider,
                "model": r.record.model,
                "provenance_url": r.record.manifest_url,
            },
        })

    app.state.service = service
    return app


def _build_from_settings():
    from sharedcache.config import Settings
    from sharedcache.embedder import GeminiEmbedder, HashEmbedder, HuggingFaceClipEmbedder
    from sharedcache.index import InMemoryCacheIndex, PgCacheIndex
    from sharedcache.generator import GenblazeGenerator, StubGenerator
    from sharedcache.storage import GenblazeS3Storage, InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from datetime import datetime, timezone

    s = Settings()
    storage = (GenblazeS3Storage(s.b2_bucket, s.b2_key_id, s.b2_app_key, s.b2_region,
                                 public_url_base=s.b2_public_url_base)
               if s.b2_bucket and s.b2_key_id else InMemoryStorage())
    if s.embedder_type == "hf":
        embedder = HuggingFaceClipEmbedder(s.hf_token, dims=s.embedding_dims)
    elif s.embedder_type == "gemini" and s.gemini_api_key:
        embedder = GeminiEmbedder(s.gemini_api_key, s.embedding_dims)
    else:
        embedder = HashEmbedder(s.embedding_dims)
    using_durable_storage = isinstance(storage, GenblazeS3Storage)
    if s.database_url and using_durable_storage:
        index = PgCacheIndex(s.database_url, s.embedding_dims)
    else:
        if s.database_url and not using_durable_storage:
            import warnings
            warnings.warn(
                "DATABASE_URL is set but storage is not durable (no B2 credentials). "
                "Using in-memory index to avoid persisting unreachable memory:// URLs. "
                "Set B2_KEY_ID, B2_APP_KEY, and B2_BUCKET to enable PgCacheIndex.",
                UserWarning,
                stacklevel=2,
            )
        index = InMemoryCacheIndex()
    generator = (GenblazeGenerator(storage, openai_api_key=s.openai_api_key,
                                   gemini_api_key=s.gemini_api_key,
                                   gmicloud_api_key=s.gmicloud_api_key)
                 if (s.openai_api_key or s.gemini_api_key or s.gmicloud_api_key) and s.b2_bucket
                 else StubGenerator(storage))
    svc = CacheService(embedder, index, generator, storage, CostMeter(),
                       created_at_fn=lambda: datetime.now(timezone.utc).isoformat())
    return build_app(svc, s.api_key)

app = _build_from_settings()
