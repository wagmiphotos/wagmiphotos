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
    app = FastAPI(title="SharedCache")

    def _check(auth: str | None):
        if api_key is None:
            return
        if auth != f"Bearer {api_key}":
            raise HTTPException(status_code=401, detail="invalid api key")

    from fastapi.responses import FileResponse
    import os

    @app.get("/")
    def index():
        path = os.path.join(os.path.dirname(__file__), "..", "..", "web", "index.html")
        return FileResponse(os.path.abspath(path))

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/v1/images/generations")
    async def generate(body: GenRequest, authorization: str | None = Header(default=None)):
        _check(authorization)
        if body.n != 1:
            raise HTTPException(status_code=422, detail="only n=1 is supported")
        r = await service.generate(body.prompt, cache_tolerance=body.cache_tolerance,
                                   size=body.size, api_key="caller")
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
    from sharedcache.embedder import GeminiEmbedder, HashEmbedder
    from sharedcache.index import InMemoryCacheIndex, PgCacheIndex
    from sharedcache.generator import GenblazeGenerator, StubGenerator
    from sharedcache.storage import GenblazeS3Storage, InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from datetime import datetime, timezone

    s = Settings()
    storage = (GenblazeS3Storage(s.b2_bucket, s.b2_key_id, s.b2_app_key, s.b2_region,
                                 public_url_base=s.b2_public_url_base)
               if s.b2_bucket and s.b2_key_id else InMemoryStorage())
    embedder = GeminiEmbedder(s.gemini_api_key, s.embedding_dims) if s.gemini_api_key else HashEmbedder(s.embedding_dims)
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
    generator = (GenblazeGenerator(storage, s.openai_api_key)
                 if s.openai_api_key and s.b2_bucket else StubGenerator(storage))
    svc = CacheService(embedder, index, generator, storage, CostMeter(),
                       created_at_fn=lambda: datetime.now(timezone.utc).isoformat())
    return build_app(svc, s.api_key)

app = _build_from_settings()
