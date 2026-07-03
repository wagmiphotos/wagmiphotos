import hmac

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from .model import ClipEncoder

# Reject bodies larger than this (bytes) before doing work. The public tunnel
# also caps request size, but the internal compose path has no other limit.
MAX_BODY_BYTES = 10 * 1024 * 1024


def create_app(encoder: ClipEncoder, token: str | None = None) -> FastAPI:
    app = FastAPI(title="sharedcache-embedder", docs_url=None, redoc_url=None)

    def check_auth(request: Request) -> None:
        if not token:
            return
        header = request.headers.get("authorization", "")
        if not hmac.compare_digest(header, f"Bearer {token}"):
            raise HTTPException(status_code=401, detail="unauthorized")

    def check_size(request: Request) -> None:
        cl = request.headers.get("content-length")
        if cl is not None and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="request body too large")

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.post("/embed/text")
    async def embed_text(request: Request):
        check_auth(request)
        check_size(request)
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=422, detail="body must be JSON") from None
        inputs = body.get("inputs") if isinstance(body, dict) else None
        if not isinstance(inputs, str) or not inputs.strip():
            raise HTTPException(status_code=422, detail="inputs must be a non-empty string")
        return [await run_in_threadpool(encoder.encode_text, inputs)]

    @app.post("/embed/image")
    async def embed_image(request: Request):
        check_auth(request)
        check_size(request)
        data = await request.body()
        if not data:
            raise HTTPException(status_code=422, detail="empty body")
        if len(data) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="request body too large")
        try:
            return [await run_in_threadpool(encoder.encode_image, data)]
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    return app
