import io, pytest
from PIL import Image
from sharedcache.backfill import BackfillWorker, normalize_prompt
from sharedcache.d1_client import QueryRow
from sharedcache.models import AssetRecord
from sharedcache.storage import InMemoryStorage
from sharedcache.generator import StubGenerator
from tests.fakes import FakeD1, FakeVectorize

class FakeClip:
    def text_embed(self, text): return [float(len(text) % 7)] * 8
    def image_embed(self, b): return [0.5] * 8

def _jpeg():
    out = io.BytesIO(); Image.new("RGB", (40, 20), "blue").save(out, format="JPEG"); return out.getvalue()

def _worker(d1, vec, **kw):
    storage = InMemoryStorage()
    return BackfillWorker(d1, vec, FakeClip(), StubGenerator(storage), storage,
                          floor_sim_max=0.35, floor_sim_min=0.18, **kw)

def test_normalize_prompt():
    assert normalize_prompt("  A  Red  Fox ") == "a red fox"

@pytest.mark.asyncio
async def test_generate_pass_builds_pending_and_upserts(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("popular", "popular", 9), QueryRow("rare", "rare", 1)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04)
    built = await w.generate_pass()
    assert built == 2
    assert d1.pending == []                       # both marked built
    assert len(vec.vectors) == 2                   # generated image vectors upserted
    assert len(d1.inserted) == 2                   # asset rows inserted
    # highest-count first
    assert d1.built[0][0] == "popular"

@pytest.mark.asyncio
async def test_generate_pass_rechecks_and_skips(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    vec.upsert("existing", [0.1] * 8, {"source": "pd12m"})
    vec.set_score("existing", 0.40)               # >= floor(0.15 tolerance -> ~0.32)
    d1.pending = [QueryRow("a cat", "a cat", 3)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    built = await w.generate_pass()
    assert built == 0                              # re-check found a match; no generation
    assert d1.inserted == []
    assert d1.built == [("a cat", "existing")]

@pytest.mark.asyncio
async def test_generate_pass_spend_cap(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow(f"p{i}", f"p{i}", 1) for i in range(5)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=0.04, price_usd=0.04)
    built = await w.generate_pass()
    assert built == 1 and len(d1.pending) == 4     # cap after one build

@pytest.mark.asyncio
async def test_rehost_pass_downloads_and_updates(monkeypatch):
    import httpx
    d1, vec = FakeD1(), FakeVectorize()
    rec = AssetRecord(id="pd1", prompt="p", url="https://ext/x.jpg", thumb_url=None, medium_url=None,
                      model_used="clip-vit-l-14", source="pd12m", source_id="7", content_hash="pd12m-7",
                      width=40, height=20, mime="image/jpeg", manifest_url=None, created_at="",
                      source_url="https://ext/x.jpg", locally_cached=False)
    d1.rehost = [rec]
    jpg = _jpeg()
    class FakeResp:
        status_code = 200; content = jpg
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, **kw): return FakeResp()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: FakeClient())
    w = _worker(d1, vec, batch_size=5)
    done = await w.rehost_pass()
    assert done == 1 and d1.rehost == []
    aid, kw = d1.url_updates[0]
    assert aid == "pd1" and kw["locally_cached"] is True and kw["url"].endswith("image.webp")
