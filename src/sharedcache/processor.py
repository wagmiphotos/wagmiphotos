import io
from PIL import Image

def dimensions(image_bytes: bytes) -> tuple[int, int]:
    return Image.open(io.BytesIO(image_bytes)).size

def make_thumbnail(image_bytes: bytes, max_px: int = 512) -> bytes:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    img.thumbnail((max_px, max_px))
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=80)
    return out.getvalue()
