import os

import uvicorn

from .app import create_app
from .model import OpenClipEncoder


def require_token(environ: dict[str, str] | None = None) -> str:
    """Return the embed token, or exit. The service is reachable on the public
    internet via the tunnel, so it must never boot without auth (fail closed)."""
    env = environ if environ is not None else os.environ
    token = (env.get("EMBED_TOKEN") or "").strip()
    if not token:
        raise SystemExit(
            "EMBED_TOKEN is required: the embedder is reachable on the public "
            "internet via the tunnel and must not run without auth. Set EMBED_TOKEN."
        )
    return token


def main() -> None:
    token = require_token()
    encoder = OpenClipEncoder(
        model_name=os.environ.get("EMBED_MODEL", "ViT-L-14"),
        pretrained=os.environ.get("EMBED_PRETRAINED", "openai"),
    )
    app = create_app(encoder, token=token)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    main()
