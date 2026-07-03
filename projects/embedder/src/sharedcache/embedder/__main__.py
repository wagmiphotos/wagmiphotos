import os

import uvicorn

from .app import create_app
from .model import OpenClipEncoder


def main() -> None:
    encoder = OpenClipEncoder(
        model_name=os.environ.get("EMBED_MODEL", "ViT-L-14"),
        pretrained=os.environ.get("EMBED_PRETRAINED", "openai"),
    )
    app = create_app(encoder, token=os.environ.get("EMBED_TOKEN") or None)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    main()
