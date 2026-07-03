from fastapi import FastAPI, HTTPException, Request

from .model import ClipEncoder


def create_app(encoder: ClipEncoder, token: str | None = None) -> FastAPI:
    app = FastAPI(title="sharedcache-embedder", docs_url=None, redoc_url=None)

    def check_auth(request: Request) -> None:
        if token and request.headers.get("authorization") != f"Bearer {token}":
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.post("/embed/text")
    async def embed_text(request: Request):
        check_auth(request)
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=422, detail="body must be JSON")
        inputs = body.get("inputs") if isinstance(body, dict) else None
        if not isinstance(inputs, str) or not inputs.strip():
            raise HTTPException(status_code=422, detail="inputs must be a non-empty string")
        return [encoder.encode_text(inputs)]

    @app.post("/embed/image")
    async def embed_image(request: Request):
        check_auth(request)
        data = await request.body()
        if not data:
            raise HTTPException(status_code=422, detail="empty body")
        try:
            return [encoder.encode_image(data)]
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))

    return app
