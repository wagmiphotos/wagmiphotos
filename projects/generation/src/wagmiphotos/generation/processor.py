import io
from PIL import Image

def dimensions(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        return img.size

def _webp(img, quality: int) -> bytes:
    out = io.BytesIO(); img.convert("RGB").save(out, format="WEBP", quality=quality); return out.getvalue()

MAX_LARGE_DIM = 2048

def derive_sizes(image_bytes: bytes, max_dim: int = MAX_LARGE_DIM) -> dict[str, bytes]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        lg = img.convert("RGB"); lg.thumbnail((max_dim, max_dim)); large = _webp(lg, 90)
        med = img.convert("RGB"); med.thumbnail((768, 768)); medium = _webp(med, 85)
        th = img.convert("RGB"); th.thumbnail((256, 256)); thumb = _webp(th, 80)
    return {"thumb": thumb, "medium": medium, "large": large}
