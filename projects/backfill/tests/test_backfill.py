import io, pytest
from PIL import Image
from sharedcache.backfill.worker import BackfillWorker, normalize_prompt
from sharedcache.common.d1_client import QueryRow
from sharedcache.common.models import AssetRecord
from sharedcache.generation.storage import InMemoryStorage
from sharedcache.generation.generator import StubGenerator
from fakes import FakeD1, FakeVectorize

class FakeClip:
    def text_embed(self, text): return [float(len(text) % 7)] * 8
    def image_embed(self, b): return [0.5] * 8

def _jpeg():
    out = io.BytesIO(); Image.new("RGB", (40, 20), "blue").save(out, format="JPEG"); return out.getvalue()

def _worker(d1, vec, **kw):
    storage = InMemoryStorage()
    return BackfillWorker(d1, vec, FakeClip(), StubGenerator(storage), storage,
                          floor_sim_max=0.35, floor_sim_min=0.18, **kw)

class _FakeStream:
    def __init__(self, status_code, chunks):
        self.status_code = status_code
        self._chunks = chunks
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def aiter_bytes(self):
        for ch in self._chunks:
            yield ch

class _FakeStreamClient:
    def __init__(self, status_code=200, chunks=()):
        self._status = status_code
        self._chunks = list(chunks)
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    def stream(self, method, url, **kw):
        return _FakeStream(self._status, self._chunks)

def _patch_httpx(monkeypatch, *, status_code=200, chunks=()):
    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FakeStreamClient(status_code, chunks))

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

def _rehost_rec():
    return AssetRecord(id="pd1", prompt="p", url="https://ext/x.jpg", thumb_url=None, medium_url=None,
                       model_used="clip-vit-l-14", source="pd12m", source_id="7", content_hash="pd12m-7",
                       width=40, height=20, mime="image/jpeg", manifest_url=None, created_at="",
                       source_url="https://ext/x.jpg", locally_cached=False)

@pytest.mark.asyncio
async def test_rehost_pass_downloads_and_updates(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, chunks=[_jpeg()])
    w = _worker(d1, vec, batch_size=5)
    done = await w.rehost_pass()
    assert done == 1 and d1.rehost == []
    aid, kw = d1.url_updates[0]
    assert aid == "pd1" and kw["locally_cached"] is True and kw["url"].endswith("image.webp")

@pytest.mark.asyncio
async def test_rehost_pass_skips_source_over_size_cap(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    rec = _rehost_rec()
    d1.rehost = [rec]
    _patch_httpx(monkeypatch, chunks=[b"x" * 6, b"x" * 6])   # 12 bytes > cap
    w = _worker(d1, vec, batch_size=5, max_rehost_bytes=10)
    done = await w.rehost_pass()
    assert done == 0
    assert d1.url_updates == []
    assert d1.rehost == [rec]        # left in place for a later attempt

@pytest.mark.asyncio
async def test_rehost_pass_skips_non_200(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, status_code=404, chunks=[])
    done = await _worker(d1, vec).rehost_pass()
    assert done == 0 and d1.url_updates == []

@pytest.mark.asyncio
async def test_generate_pass_writes_provenance_manifest():
    import json
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("popular", "popular", 9)]
    storage = InMemoryStorage()
    w = BackfillWorker(d1, vec, FakeClip(), StubGenerator(storage), storage,
                       floor_sim_max=0.35, floor_sim_min=0.18, batch_size=5, max_spend_usd=100.0)
    assert await w.generate_pass() == 1
    rec = d1.inserted[0]
    assert rec.manifest_url is not None and rec.manifest_url.endswith("manifest.json")
    manifest = json.loads(storage.get(f"assets/{rec.id}/manifest.json"))
    assert manifest["id"] == rec.id
    assert manifest["prompt"] == "popular"
    assert manifest["source"] == "generated"
    assert manifest["sizes"]["large"] == rec.url

@pytest.mark.asyncio
async def test_lifetime_spend_cap_persists_across_ticks():
    d1, vec = FakeD1(), FakeVectorize()
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04,
                max_lifetime_spend_usd=0.04)
    d1.pending = [QueryRow("a", "a", 1)]
    assert await w.generate_pass() == 1        # spends the whole lifetime budget
    d1.pending = [QueryRow("b", "b", 1)]
    assert await w.generate_pass() == 0        # lifetime cap already reached
    assert len(d1.inserted) == 1

def test_build_worker_from_settings_warns_on_stub_fallback(caplog):
    from sharedcache.backfill.worker import build_worker_from_settings
    from sharedcache.common.config import Settings
    s = Settings(_env_file=None, gmicloud_api_key=None, openai_api_key=None,
                 gemini_api_key=None, b2_bucket=None, b2_key_id=None)
    with caplog.at_level("WARNING"):
        build_worker_from_settings(s)
    assert any("stub" in r.getMessage().lower() for r in caplog.records)

@pytest.mark.asyncio
async def test_run_once_calls_tick_once():
    d1, vec = FakeD1(), FakeVectorize()
    w = _worker(d1, vec)
    calls = {"n": 0}
    async def fake_tick():
        calls["n"] += 1; return {"generated": 0, "rehosted": 0}
    w.tick = fake_tick
    await w.run(interval_seconds=0, once=True)
    assert calls["n"] == 1
