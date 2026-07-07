import io
from PIL import Image
from wagmiphotos.generation import processor
from wagmiphotos.generation.processor import derive_sizes, dimensions

def _png(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 200)).save(buf, format="PNG")
    return buf.getvalue()

def test_dimensions_reads_size():
    assert dimensions(_png(640, 480)) == (640, 480)

def test_derive_sizes_produces_three_webp():
    out = derive_sizes(_png(2000, 1000))
    assert set(out) == {"thumb", "medium", "large"}
    for name, cap in (("thumb", 256), ("medium", 768), ("large", 2000)):
        w, h = Image.open(io.BytesIO(out[name])).size
        assert max(w, h) <= cap
        assert Image.open(io.BytesIO(out[name])).format == "WEBP"

def test_derive_sizes_preserves_aspect_ratio():
    out = derive_sizes(_png(2000, 1000))
    assert Image.open(io.BytesIO(out["thumb"])).size == (256, 128)
    assert Image.open(io.BytesIO(out["medium"])).size == (768, 384)

def test_single_use_helpers_are_gone():
    # make_thumbnail/to_webp were superseded by derive_sizes
    assert not hasattr(processor, "make_thumbnail")
    assert not hasattr(processor, "to_webp")

def test_derive_sizes_caps_large_at_2048():
    out = derive_sizes(_png(3000, 1500))
    assert Image.open(io.BytesIO(out["large"])).size == (2048, 1024)

def test_derive_sizes_never_upscales_large():
    out = derive_sizes(_png(2000, 1000))
    assert Image.open(io.BytesIO(out["large"])).size == (2000, 1000)

def test_max_large_dim_constant():
    assert processor.MAX_LARGE_DIM == 2048
