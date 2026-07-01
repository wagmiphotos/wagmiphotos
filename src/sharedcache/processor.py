import io
from PIL import Image

def dimensions(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        return img.size

def make_thumbnail(image_bytes: bytes, max_px: int = 512) -> bytes:
    with Image.open(io.BytesIO(image_bytes)) as img:
        rgb = img.convert("RGB")
        rgb.thumbnail((max_px, max_px))
        out = io.BytesIO()
        rgb.save(out, format="WEBP", quality=80)
        return out.getvalue()

def to_webp(image_bytes: bytes, quality: int = 90) -> bytes:
    with Image.open(io.BytesIO(image_bytes)) as img:
        rgb = img.convert("RGB")
        out = io.BytesIO()
        rgb.save(out, format="WEBP", quality=quality)
        return out.getvalue()
