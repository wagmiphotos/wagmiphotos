import io
from PIL import Image
from sharedcache.processor import make_thumbnail, dimensions

def _png(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 200)).save(buf, format="PNG")
    return buf.getvalue()

def test_thumbnail_is_webp_and_bounded():
    out = make_thumbnail(_png(2000, 1000), max_px=512)
    img = Image.open(io.BytesIO(out))
    assert img.format == "WEBP"
    assert max(img.size) <= 512

def test_dimensions_reads_size():
    assert dimensions(_png(640, 480)) == (640, 480)
