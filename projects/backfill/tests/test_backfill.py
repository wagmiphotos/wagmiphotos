import io, logging, pytest
from PIL import Image
from wagmiphotos.backfill.worker import SPEND_META_KEY, BackfillWorker
from wagmiphotos.common.asset_paths import asset_key
from wagmiphotos.common.d1_client import QueryRow
from wagmiphotos.common.models import AssetRecord
from wagmiphotos.generation.storage import InMemoryStorage
from wagmiphotos.generation.generator import StubGenerator, build_model_id
from fakes import FakeD1, FakeVectorize

TEST_MODEL = build_model_id("gmicloud", "gpt-image-1")

class FakeEmbedder:
    def text_embed(self, text): return [float(len(text) % 7)] * 8

def _jpeg():
    out = io.BytesIO(); Image.new("RGB", (40, 20), "blue").save(out, format="JPEG"); return out.getvalue()

def _worker(d1, vec, **kw):
    storage = InMemoryStorage()
    kw.setdefault("model", TEST_MODEL)
    return BackfillWorker(d1, vec, FakeEmbedder(), StubGenerator(storage), storage,
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
    instances = 0
    def __init__(self, status_code=200, chunks=()):
        type(self).instances += 1
        self._status = status_code
        self._chunks = list(chunks)
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    def stream(self, method, url, **kw):
        return _FakeStream(self._status, self._chunks)

def _patch_httpx(monkeypatch, *, status_code=200, chunks=()):
    import httpx
    _FakeStreamClient.instances = 0
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FakeStreamClient(status_code, chunks))

@pytest.mark.asyncio
async def test_generate_pass_builds_pending_and_upserts(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("popular", "popular", 9), QueryRow("rare", "rare", 1)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04)
    built = await w.generate_pass()
    assert built == 2
    assert d1.pending == []                       # both marked built
    assert len(vec.vectors) == 2                   # generated prompt vectors upserted
    assert len(d1.inserted) == 2                   # asset rows inserted
    # highest-count first
    assert d1.built[0][0] == "popular"
    # upserted vector is the prompt's BGE embedding, not a separate image vector
    popular_asset_id = d1.built[0][1]
    assert vec.vectors[popular_asset_id]["values"] == FakeEmbedder().text_embed("popular")
    # freshly generated assets are an exact answer for the prompt
    assert d1.similarities["popular"] == 1.0
    assert d1.claims == {}                         # no claims left dangling
    # each generated asset records the price paid and the provider that made it
    # (TEST_MODEL is wagmiphotos-gmicloud-...), captured per-image at gen time.
    assert all(a.price_usd == 0.04 for a in d1.inserted)
    assert all(a.provider == "gmicloud" for a in d1.inserted)

@pytest.mark.asyncio
async def test_generate_pass_uses_configured_generation_size():
    # Generation size is model-dependent (Seedream rejects 1024x1024, needs
    # 2048x2048), so the worker must pass its configured size to the generator.
    class SizeRecordingStub(StubGenerator):
        def __init__(self, storage):
            super().__init__(storage); self.sizes = []
        async def generate(self, prompt, *, model, size="1024x1024", provider_api_key=None):
            self.sizes.append(size)
            return await super().generate(prompt, model=model, size=size)
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("p", "p", 1)]
    storage = InMemoryStorage()
    gen = SizeRecordingStub(storage)
    w = BackfillWorker(d1, vec, FakeEmbedder(), gen, storage, model=TEST_MODEL,
                       floor_sim_max=0.35, floor_sim_min=0.18, generation_size="2048x2048")
    await w.generate_pass()
    assert gen.sizes == ["2048x2048"]


@pytest.mark.asyncio
async def test_generate_pass_skips_below_min_requests():
    # Demand gate: don't spend on one-off prompts — only build ones requested
    # at least generation_min_requests times.
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("hot", "hot", 12), QueryRow("cold", "cold", 3)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04,
                generation_min_requests=10)
    built = await w.generate_pass()
    assert built == 1                        # only 'hot' (12 >= 10) generates
    assert [b[0] for b in d1.built] == ["hot"]   # 'cold' (3) is below the threshold


@pytest.mark.asyncio
async def test_generate_pass_rechecks_and_skips(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.assets["existing"] = {"id": "existing"}     # the matched id really exists in D1
    vec.upsert("existing", [0.1] * 8, {"source": "pd12m"})
    vec.set_score("existing", 0.40)               # >= floor(0.15 tolerance -> ~0.32)
    d1.pending = [QueryRow("a cat", "a cat", 3)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    built = await w.generate_pass()
    assert built == 0                              # re-check found a match; no generation
    assert d1.inserted == []
    assert d1.built == [("a cat", "existing")]
    assert d1.similarities["a cat"] == 0.40        # match score is recorded

@pytest.mark.asyncio
async def test_recheck_ignores_dangling_vector_and_generates(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    vec.set_score("ghost", 0.99)                   # vector exists, D1 row does not
    d1.pending = [QueryRow("a cat", "a cat", 3)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    built = await w.generate_pass()
    assert built == 1                              # fell through to generation
    assert len(d1.inserted) == 1
    assert d1.built[0][0] == "a cat" and d1.built[0][1] != "ghost"

@pytest.mark.asyncio
async def test_generate_pass_spend_cap(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow(f"p{i}", f"p{i}", 1) for i in range(5)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=0.04, price_usd=0.04)
    built = await w.generate_pass()
    assert built == 1 and len(d1.pending) == 4     # cap after one build
    assert d1.claims == {}                         # cap-break released its claim

@pytest.mark.asyncio
async def test_generate_pass_isolates_poisoned_prompt(caplog):
    class ExplodingGenerator:
        async def generate(self, prompt, *, model, size="1024x1024", provider_api_key=None):
            raise RuntimeError(f"provider exploded for {prompt}")
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("bad", "bad", 9), QueryRow("good", "good", 1)]
    storage = InMemoryStorage()
    class SelectiveGenerator(StubGenerator):
        async def generate(self, prompt, **kw):
            if prompt == "bad":
                raise RuntimeError("provider exploded")
            return await super().generate(prompt, **kw)
    w = BackfillWorker(d1, vec, FakeEmbedder(), SelectiveGenerator(storage), storage,
                       floor_sim_max=0.35, floor_sim_min=0.18, batch_size=5,
                       max_spend_usd=100.0, model=TEST_MODEL)
    with caplog.at_level(logging.ERROR):
        built = await w.generate_pass()
    assert built == 1                              # "good" was still processed
    assert d1.built == [("good", d1.inserted[0].id)]
    assert d1.attempts["bad"] == 1                 # failure charged an attempt
    assert d1.failures[0][0] == "bad" and "provider exploded" in d1.failures[0][1]
    assert d1.claims.get("bad") is None            # claim was released
    assert any("bad" in r.getMessage() and r.exc_info for r in caplog.records)

@pytest.mark.asyncio
async def test_generate_pass_skips_row_claimed_by_other_worker():
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("taken", "taken", 5)]
    d1.claims["taken"] = "fresh"                   # another worker holds the claim
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    assert await w.generate_pass() == 0
    assert d1.inserted == [] and d1.built == []
    assert d1.pending != []                        # left for the claim holder

@pytest.mark.asyncio
async def test_generate_pass_reclaims_stale_claim():
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("stuck", "stuck", 5)]
    d1.claims["stuck"] = "stale"                   # abandoned > claim TTL ago
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    assert await w.generate_pass() == 1
    assert d1.built[0][0] == "stuck"

@pytest.mark.asyncio
async def test_generate_pass_inserts_asset_before_vector_upsert():
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("p", "p", 1)]
    events = []
    orig_insert, orig_upsert = d1.insert_asset, vec.upsert
    d1.insert_asset = lambda rec: (events.append("d1.insert_asset"), orig_insert(rec))[1]
    vec.upsert = lambda *a, **k: (events.append("vec.upsert"), orig_upsert(*a, **k))[1]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    await w.generate_pass()
    assert events == ["d1.insert_asset", "vec.upsert"]

@pytest.mark.asyncio
async def test_vector_upsert_failure_keeps_asset_and_spend(caplog):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("p", "p", 1)]
    def boom(*a, **k): raise RuntimeError("vectorize down")
    vec.upsert = boom
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04)
    with caplog.at_level(logging.ERROR):
        built = await w.generate_pass()
    assert built == 0
    assert len(d1.inserted) == 1                   # servable-but-unindexed, not dangling vector
    assert d1.built == []                          # not marked built -> retried later
    assert float(d1.meta[SPEND_META_KEY]) == 0.04  # money paid still counts

@pytest.mark.asyncio
async def test_generate_pass_writes_provenance_manifest():
    import json
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("popular", "popular", 9)]
    storage = InMemoryStorage()
    w = BackfillWorker(d1, vec, FakeEmbedder(), StubGenerator(storage), storage,
                       floor_sim_max=0.35, floor_sim_min=0.18, batch_size=5,
                       max_spend_usd=100.0, model=TEST_MODEL)
    assert await w.generate_pass() == 1
    rec = d1.inserted[0]
    # derived-URL design: AssetRecord carries no URL fields
    assert not hasattr(rec, "url") and not hasattr(rec, "manifest_url")
    assert not hasattr(rec, "thumb_url") and not hasattr(rec, "medium_url")
    # storage.put was called with the exact contract-pinned keys (asset_key)
    assert storage.get(asset_key("large", rec.id))
    assert storage.get(asset_key("medium", rec.id))
    assert storage.get(asset_key("thumb", rec.id))
    manifest = json.loads(storage.get(asset_key("manifest", rec.id)))
    assert manifest["id"] == rec.id
    assert manifest["prompt"] == "popular"
    assert manifest["source"] == "generated"
    # model_used flows from the generator into the inserted record (the worker
    # serves it via shared_cache.model_used / library publicAsset)
    assert rec.model_used and rec.model_used == manifest["model_used"]
    # the manifest still embeds the real URL returned by storage.put (ground truth)
    assert manifest["sizes"]["large"] == InMemoryStorage.BASE + asset_key("large", rec.id)

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

@pytest.mark.asyncio
async def test_lifetime_spend_survives_worker_restart():
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("a", "a", 1)]
    w1 = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04,
                 max_lifetime_spend_usd=0.04)
    assert await w1.generate_pass() == 1
    assert float(d1.meta[SPEND_META_KEY]) == 0.04  # durably recorded in meta
    # "restart": a brand-new worker against the same database
    d1.pending = [QueryRow("b", "b", 1)]
    w2 = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04,
                 max_lifetime_spend_usd=0.04)
    assert await w2.generate_pass() == 0           # cap read back from meta
    assert len(d1.inserted) == 1

def _rehost_rec(id="pd1"):
    return AssetRecord(id=id, prompt="p", model_used="clip-vit-l-14", source="pd12m",
                       source_id="7", content_hash="pd12m-7", width=40, height=20,
                       mime="image/jpeg", created_at="", source_url="https://ext/x.jpg",
                       locally_cached=False)

@pytest.mark.asyncio
async def test_rehost_pass_downloads_and_updates(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, chunks=[_jpeg()])
    w = _worker(d1, vec, batch_size=5)
    done = await w.rehost_pass()
    assert done == 1 and d1.rehost == []
    aid, kw = d1.rehost_marks[0]
    assert aid == "pd1" and kw["mime"] == "image/webp"
    # bytes actually landed at the contract-pinned key
    assert w._storage.get(asset_key("large", "pd1"))

@pytest.mark.asyncio
async def test_rehost_pass_reuses_one_http_client(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec("pd1"), _rehost_rec("pd2")]
    _patch_httpx(monkeypatch, chunks=[_jpeg()])
    done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 2
    assert _FakeStreamClient.instances == 1        # one client for the whole pass

@pytest.mark.asyncio
async def test_rehost_pass_skips_source_over_size_cap(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    rec = _rehost_rec()
    d1.rehost = [rec]
    _patch_httpx(monkeypatch, chunks=[b"x" * 6, b"x" * 6])   # 12 bytes > cap
    w = _worker(d1, vec, batch_size=5, max_rehost_bytes=10)
    done = await w.rehost_pass()
    assert done == 0
    assert d1.rehost_marks == []
    assert d1.rehost == [rec]        # left in place for a later attempt
    assert d1.rehost_attempts["pd1"] == 1

@pytest.mark.asyncio
async def test_rehost_pass_failure_increments_attempts_and_logs(monkeypatch, caplog):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, status_code=500, chunks=[])
    with caplog.at_level(logging.ERROR):
        done = await _worker(d1, vec).rehost_pass()
    assert done == 0 and d1.rehost_marks == []
    assert d1.rehost_attempts["pd1"] == 1
    assert any("pd1" in r.getMessage() and r.exc_info for r in caplog.records)
    assert d1.dead == {} and vec.deleted == []     # below budget: retry, don't tombstone

def test_build_worker_from_settings_warns_on_stub_fallback(caplog, monkeypatch):
    from wagmiphotos.backfill.worker import build_worker_from_settings
    from wagmiphotos.common.bge import BgeEmbedder
    from wagmiphotos.common.config import Settings
    monkeypatch.setattr(BgeEmbedder, "from_pretrained", classmethod(lambda cls, model_name: FakeEmbedder()))
    s = Settings(_env_file=None, gmicloud_api_key=None, openai_api_key=None,
                 gemini_api_key=None, b2_bucket=None, b2_key_id=None, b2_app_key=None)
    with caplog.at_level("WARNING"):
        build_worker_from_settings(s)
    assert any("stub" in r.getMessage().lower() for r in caplog.records)

def test_build_worker_from_settings_model_comes_from_config(monkeypatch):
    from wagmiphotos.backfill.worker import build_worker_from_settings
    from wagmiphotos.common.bge import BgeEmbedder
    from wagmiphotos.common.config import Settings
    monkeypatch.setattr(BgeEmbedder, "from_pretrained", classmethod(lambda cls, model_name: FakeEmbedder()))
    s = Settings(_env_file=None, default_provider="openai", default_image_model="dall-e-3",
                 b2_bucket=None, b2_key_id=None, b2_app_key=None)
    w = build_worker_from_settings(s)
    assert w._model == "wagmiphotos-openai-dall-e-3"

def test_build_worker_from_settings_rejects_partial_b2(monkeypatch):
    from wagmiphotos.backfill.worker import build_worker_from_settings
    from wagmiphotos.common.bge import BgeEmbedder
    from wagmiphotos.common.config import Settings
    monkeypatch.setattr(BgeEmbedder, "from_pretrained", classmethod(lambda cls, model_name: FakeEmbedder()))
    s = Settings(_env_file=None, b2_bucket="bucket", b2_key_id=None, b2_app_key=None)
    with pytest.raises(ValueError) as e:
        build_worker_from_settings(s)
    assert "B2_KEY_ID" in str(e.value) and "B2_APP_KEY" in str(e.value)

def test_build_worker_from_settings_preflights_provider(monkeypatch):
    from wagmiphotos.backfill.worker import build_worker_from_settings
    from wagmiphotos.common.bge import BgeEmbedder
    from wagmiphotos.common.config import Settings
    import wagmiphotos.generation.storage as storage_mod
    monkeypatch.setattr(BgeEmbedder, "from_pretrained", classmethod(lambda cls, model_name: FakeEmbedder()))
    monkeypatch.setattr(storage_mod, "GenblazeS3Storage",
                        lambda *a, **k: InMemoryStorage())
    # google provider is configured but genblaze-google is not installed
    s = Settings(_env_file=None, gemini_api_key="k", default_provider="google",
                 default_image_model="imagen-3",
                 b2_bucket="b", b2_key_id="k", b2_app_key="a")
    with pytest.raises(ValueError) as e:
        build_worker_from_settings(s)
    assert "not installed" in str(e.value)

@pytest.mark.asyncio
async def test_run_once_calls_tick_once_and_logs(caplog):
    d1, vec = FakeD1(), FakeVectorize()
    w = _worker(d1, vec)
    calls = {"n": 0}
    async def fake_tick():
        calls["n"] += 1; return {"generated": 0, "rehosted": 0}
    w.tick = fake_tick
    with caplog.at_level(logging.INFO):
        await w.run(interval_seconds=0, once=True)
    assert calls["n"] == 1
    assert any("backfill tick" in r.getMessage() for r in caplog.records)

@pytest.mark.asyncio
async def test_run_once_logs_tick_failure(caplog):
    d1, vec = FakeD1(), FakeVectorize()
    w = _worker(d1, vec)
    async def bad_tick(): raise RuntimeError("tick exploded")
    w.tick = bad_tick
    with caplog.at_level(logging.ERROR):
        await w.run(interval_seconds=0, once=True)
    assert any(r.exc_info for r in caplog.records)

@pytest.mark.asyncio
async def test_rehost_pass_tombstones_on_404(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, status_code=404)
    done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 0
    assert d1.dead == {"pd1": "http 404"}
    assert d1.rehost_attempts == {}                # gone-signal spends no attempt
    assert vec.deleted == [["pd1"]]

@pytest.mark.asyncio
async def test_rehost_pass_tombstones_on_410(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, status_code=410)
    await _worker(d1, vec, batch_size=5).rehost_pass()
    assert d1.dead == {"pd1": "http 410"}

@pytest.mark.asyncio
async def test_rehost_pass_tombstones_after_exhausted_retries(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    d1.rehost_attempts["pd1"] = 4                   # one failure away from the budget
    _patch_httpx(monkeypatch, status_code=500)
    done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 0
    assert d1.rehost_attempts["pd1"] == 5
    assert d1.dead == {"pd1": "retries exhausted"}
    assert vec.deleted == [["pd1"]]

@pytest.mark.asyncio
async def test_vector_delete_failure_keeps_asset_dead_and_pass_alive(monkeypatch, caplog):
    class ExplodingVec(FakeVectorize):
        def delete(self, ids):
            raise RuntimeError("vectorize down")
    d1, vec = FakeD1(), ExplodingVec()
    d1.rehost = [_rehost_rec(), _rehost_rec("pd2")]
    _patch_httpx(monkeypatch, status_code=404)
    with caplog.at_level(logging.ERROR):
        done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 0
    assert set(d1.dead) == {"pd1", "pd2"}           # D1-first: death sticks
    assert "vector delete failed" in caplog.text
