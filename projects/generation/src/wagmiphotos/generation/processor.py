import io
from PIL import Image

def dimensions(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        return img.size

def _webp(img, quality: int) -> bytes:
    out = io.BytesIO(); img.convert("RGB").save(out, format="WEBP", quality=quality); return out.getvalue()

def derive_sizes(image_bytes: bytes) -> dict[str, bytes]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        large = _webp(img, 90)
        med = img.convert("RGB"); med.thumbnail((768, 768)); medium = _webp(med, 85)
        th = img.convert("RGB"); th.thumbnail((256, 256)); thumb = _webp(th, 80)
    return {"thumb": thumb, "medium": medium, "large": large}
