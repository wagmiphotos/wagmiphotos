import sys

import pytest

from wagmiphotos.common.config import Settings
from wagmiphotos.common.models import AssetRecord
from fakes import FakeD1, FakeVectorize
from wagmiphotos.backfill import seed_pd12m


class FakeEmbedder:
    def text_embed(self, text): return [float(len(text) % 7)] * 8


class _Resp:
    def __init__(self, data, status=200):
        self._d, self.status_code, self.text = data, status, "err"
    def json(self): return self._d


class FakeHf:
    """Fake httpx.Client serving a paged HF /rows dataset."""

    def __init__(self, total_rows, status=200):
        self.rows = [{"row_idx": i,
                      "row": {"id": f"r{i}", "caption": f"caption {i}",
                              "url": f"https://ext/{i}.jpg", "width": 10, "height": 10}}
                     for i in range(total_rows)]
        self.status = status
        self.calls = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append(dict(params))
        if self.status != 200:
            return _Resp({}, status=self.status)
        offset, length = params["offset"], params["length"]
        return _Resp({"rows": self.rows[offset:offset + length]})


def test_seed_rows_inserts_d1_and_vectorize():
    d1, vec = FakeD1(), FakeVectorize()
    rows = [{"id": "7", "prompt": "a fox", "url": "https://ext/fox.jpg",
             "width": 100, "height": 80, "mime": "image/jpeg", "embedding": [0.1] * 768}]
    n = seed_pd12m.seed_rows(rows, d1, vec)
    assert n == 1
    rec = d1.inserted[0]
    assert isinstance(rec, AssetRecord) and rec.source == "pd12m" and rec.source_id == "7"
    assert rec.locally_cached is False and rec.source_url == "https://ext/fox.jpg"
    assert not hasattr(rec, "url")  # derived, not stored
    assert list(vec.vectors)[0] == rec.id and vec.vectors[rec.id]["metadata"] == {"source": "pd12m"}


def test_seed_from_hf_pages_with_length_max_100():
    d1, vec = FakeD1(), FakeVectorize()
    hf = FakeHf(total_rows=200)
    n = seed_pd12m.seed_from_hf("repo/x", 150, d1, vec, FakeEmbedder(), client=hf)
    assert n == 150
    assert len(d1.inserted) == 150
    # HF /rows takes offset+length (max 100); `limit=` is silently ignored there
    assert hf.calls == [
        {"dataset": "repo/x", "config": "default", "split": "train", "offset": 0, "length": 100},
        {"dataset": "repo/x", "config": "default", "split": "train", "offset": 100, "length": 50},
    ]
    # writes are paired per chunk: one Vectorize insert per fetched page
    assert vec.insert_calls == 2


def test_seed_from_hf_stops_when_dataset_exhausted():
    d1, vec = FakeD1(), FakeVectorize()
    hf = FakeHf(total_rows=3)
    n = seed_pd12m.seed_from_hf("repo/x", 50, d1, vec, FakeEmbedder(), client=hf)
    assert n == 3
    assert len(hf.calls) == 1  # short page -> no pointless extra fetch


def test_seed_from_hf_dedupes_existing_source_ids():
    d1, vec = FakeD1(), FakeVectorize()
    hf = FakeHf(total_rows=3)
    # r1 was seeded on a previous run
    d1.insert_asset(AssetRecord(
        id="old", prompt="p", model_used=None, source="pd12m", source_id="r1",
        content_hash="h", width=1, height=1, mime="image/jpeg", created_at=""))
    n = seed_pd12m.seed_from_hf("repo/x", 3, d1, vec, FakeEmbedder(), client=hf)
    assert n == 2                                             # r1 skipped
    assert {rec.source_id for rec in d1.inserted if rec.id != "old"} == {"r0", "r2"}


def test_seed_from_hf_raises_on_http_error():
    d1, vec = FakeD1(), FakeVectorize()
    hf = FakeHf(total_rows=3, status=503)
    with pytest.raises(RuntimeError) as e:
        seed_pd12m.seed_from_hf("repo/x", 3, d1, vec, FakeEmbedder(), client=hf)
    assert "HF" in str(e.value) and "503" in str(e.value)


def test_seed_from_hf_embedder_error_propagates_as_itself():
    class BoomEmbedder:
        def text_embed(self, text): raise ValueError("bad embedding")
    d1, vec = FakeD1(), FakeVectorize()
    hf = FakeHf(total_rows=3)
    with pytest.raises(ValueError) as e:
        seed_pd12m.seed_from_hf("repo/x", 3, d1, vec, BoomEmbedder(), client=hf)
    assert "bad embedding" in str(e.value)  # not masked as an HF fetch error


def test_main_exits_nonzero_on_failure(monkeypatch):
    monkeypatch.setattr(seed_pd12m, "build_clients", lambda s: (None, None, None))
    def boom(*a, **kw): raise RuntimeError("seed exploded")
    monkeypatch.setattr(seed_pd12m, "seed_from_hf", boom)
    monkeypatch.setattr(sys, "argv", ["seed_pd12m"])
    with pytest.raises(SystemExit) as e:
        seed_pd12m.main()
    assert e.value.code == 1


def test_default_repo_is_a_named_constant():
    assert seed_pd12m.DEFAULT_HF_REPO_ID == "jorissup/PD12M-bucket"


def test_build_clients_uses_correct_settings_attrs_and_kwargs(monkeypatch):
    from wagmiphotos.common.bge import BgeEmbedder

    monkeypatch.setattr(BgeEmbedder, "from_pretrained", classmethod(lambda cls, model_name: FakeEmbedder()))
    settings = Settings(
        cf_account_id="a", d1_database_id="d", vectorize_index_prefix="wagmiphotos-bge-",
        vectorize_shards=3, cf_api_token="t")
    d1, vectorize, embedder = seed_pd12m.build_clients(settings)
    assert d1 is not None and vectorize is not None and embedder is not None
