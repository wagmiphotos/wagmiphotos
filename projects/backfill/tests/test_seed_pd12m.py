import sys

import pytest

from wagmiphotos.common.config import Settings
from wagmiphotos.common.models import AssetRecord
from fakes import FakeD1, FakeVectorize
from wagmiphotos.backfill import seed_pd12m


class FakeEmbedder:
    def __init__(self): self.many_calls = []
    def text_embed(self, text): return [float(len(text) % 7)] * 8
    def text_embed_many(self, texts):
        self.many_calls.append(len(texts))       # record per-page batch sizes
        return [self.text_embed(t) for t in texts]


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


def _prow(i, **overrides):
    row = {"id": f"p{i}", "url": f"https://pd12m.s3/img{i}.jpeg", "caption": f"caption {i}",
           "width": 100 + i, "height": 200 + i, "mime_type": "image/png", "hash": f"h{i}",
           "license": "cc0", "source": "Some Museum"}
    row.update(overrides)
    return row


def _write_parquet_dir(tmp_path, files):
    import pyarrow as pa
    import pyarrow.parquet as pq
    d = tmp_path / "metadata"
    d.mkdir()
    for i, rows in enumerate(files):
        pq.write_table(pa.Table.from_pylist(rows), d / f"pd12m.{i:03d}.parquet")
    return d


def test_seed_from_parquet_seeds_up_to_limit_across_files(tmp_path):
    d1, vec = FakeD1(), FakeVectorize()
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(3)],
                                         [_prow(i) for i in range(3, 6)]])
    n = seed_pd12m.seed_from_parquet(meta, 5, d1, vec, FakeEmbedder())
    assert n == 5
    assert {r.source_id for r in d1.inserted} == {"p0", "p1", "p2", "p3", "p4"}


def test_seed_from_parquet_dedupes_existing_source_ids(tmp_path):
    d1, vec = FakeD1(), FakeVectorize()
    d1.insert_asset(AssetRecord(
        id="old", prompt="p", model_used=None, source="pd12m", source_id="p1",
        content_hash="h", width=1, height=1, mime="image/jpeg", created_at=""))
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(3)]])
    n = seed_pd12m.seed_from_parquet(meta, 10, d1, vec, FakeEmbedder())
    assert n == 2
    assert {r.source_id for r in d1.inserted if r.id != "old"} == {"p0", "p2"}


def test_seed_from_parquet_maps_mime_and_real_content_hash(tmp_path):
    d1, vec = FakeD1(), FakeVectorize()
    meta = _write_parquet_dir(tmp_path, [[_prow(0)]])
    seed_pd12m.seed_from_parquet(meta, 1, d1, vec, FakeEmbedder())
    rec = d1.inserted[0]
    assert rec.mime == "image/png"          # from mime_type, not hardcoded jpeg
    assert rec.content_hash == "h0"         # the dataset's real hash, not synthetic
    assert rec.source_url == "https://pd12m.s3/img0.jpeg"


def test_seed_from_parquet_skips_rows_missing_caption_or_url(tmp_path):
    d1, vec = FakeD1(), FakeVectorize()
    meta = _write_parquet_dir(tmp_path, [[_prow(0, caption=None), _prow(1, url=None), _prow(2)]])
    n = seed_pd12m.seed_from_parquet(meta, 10, d1, vec, FakeEmbedder())
    assert n == 1
    assert d1.inserted[0].source_id == "p2"


def test_seed_from_parquet_raises_on_empty_dir(tmp_path):
    (tmp_path / "empty").mkdir()
    with pytest.raises(RuntimeError, match="parquet"):
        seed_pd12m.seed_from_parquet(tmp_path / "empty", 1, FakeD1(), FakeVectorize(), FakeEmbedder())


# --- Batched fast path ---------------------------------------------------

def test_seed_rows_bulk_writes_via_bulk_insert_and_one_vectorize_batch():
    d1, vec = FakeD1(), FakeVectorize()
    rows = [{"id": str(i), "prompt": f"p{i}", "url": f"https://ext/{i}.jpg",
             "width": 10, "height": 10, "mime": "image/jpeg", "embedding": [0.1] * 8}
            for i in range(3)]
    n = seed_pd12m.seed_rows_bulk(rows, d1, vec)
    assert n == 3
    assert {r.source_id for r in d1.inserted} == {"0", "1", "2"}
    assert all(r.source == "pd12m" and r.locally_cached is False for r in d1.inserted)
    assert len(vec.vectors) == 3 and vec.insert_calls == 1     # one batched vectorize write
    # every asset id is present as a vector with the source tag
    assert {r.id for r in d1.inserted} == set(vec.vectors)
    assert all(v["metadata"] == {"source": "pd12m"} for v in vec.vectors.values())


def test_seed_rows_bulk_writes_vectorize_first_no_d1_orphan_on_failure():
    """Vectorize is written before D1, so a Vectorize crash leaves NO D1 row for
    that page (a benign orphan vector at worst, which the Worker tolerates) —
    never an orphan D1 row that is served but missing from similarity search."""
    class BoomVectorize(FakeVectorize):
        def insert_many(self, vectors): raise RuntimeError("vectorize down")
    d1, vec = FakeD1(), BoomVectorize()
    rows = [{"id": "1", "prompt": "p", "url": "https://ext/1.jpg", "width": 1,
             "height": 1, "mime": "image/jpeg", "embedding": [0.1] * 8}]
    with pytest.raises(RuntimeError, match="vectorize down"):
        seed_pd12m.seed_rows_bulk(rows, d1, vec)
    assert d1.inserted == []                    # D1 untouched when Vectorize fails


def test_seed_from_parquet_fast_seeds_up_to_limit_across_files(tmp_path):
    d1, vec = FakeD1(), FakeVectorize()
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(3)],
                                         [_prow(i) for i in range(3, 6)]])
    n = seed_pd12m.seed_from_parquet_fast(meta, 5, d1, vec, FakeEmbedder(), page_size=2)
    assert n == 5
    assert {r.source_id for r in d1.inserted} == {"p0", "p1", "p2", "p3", "p4"}


def test_seed_from_parquet_fast_dedupes_existing_source_ids(tmp_path):
    d1, vec = FakeD1(), FakeVectorize()
    d1.insert_asset(AssetRecord(
        id="old", prompt="p", model_used=None, source="pd12m", source_id="p1",
        content_hash="h", width=1, height=1, mime="image/jpeg", created_at=""))
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(3)]])
    n = seed_pd12m.seed_from_parquet_fast(meta, 10, d1, vec, FakeEmbedder())
    assert n == 2
    assert {r.source_id for r in d1.inserted if r.id != "old"} == {"p0", "p2"}


def test_seed_from_parquet_fast_batch_embeds_once_per_page(tmp_path):
    d1, vec, emb = FakeD1(), FakeVectorize(), FakeEmbedder()
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(4)]])
    seed_pd12m.seed_from_parquet_fast(meta, 4, d1, vec, emb, page_size=2)
    assert emb.many_calls == [2, 2]        # 2 pages, each embedded in one batched call


def test_seed_from_parquet_fast_skip_fast_forwards_candidates(tmp_path):
    """`skip` fast-forwards past the first N candidates WITHOUT deduping them
    (the expensive existing_source_ids reads), so a top-up doesn't re-scan the
    whole already-seeded prefix. It only affects speed — never correctness."""
    d1, vec, emb = FakeD1(), FakeVectorize(), FakeEmbedder()
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(6)]])
    n = seed_pd12m.seed_from_parquet_fast(meta, 10, d1, vec, emb, page_size=2, skip=4)
    assert n == 2
    assert {r.source_id for r in d1.inserted} == {"p4", "p5"}    # p0..p3 skipped, not seeded


def test_seed_from_parquet_fast_skip_beyond_data_seeds_nothing(tmp_path):
    d1, vec, emb = FakeD1(), FakeVectorize(), FakeEmbedder()
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(3)]])
    n = seed_pd12m.seed_from_parquet_fast(meta, 10, d1, vec, emb, skip=99)
    assert n == 0 and d1.inserted == []


def test_seed_from_parquet_fast_skips_embedding_fully_deduped_page(tmp_path):
    d1, vec, emb = FakeD1(), FakeVectorize(), FakeEmbedder()
    for i in range(2):                      # pre-seed the whole first page
        d1.insert_asset(AssetRecord(
            id=f"old{i}", prompt="p", model_used=None, source="pd12m", source_id=f"p{i}",
            content_hash="h", width=1, height=1, mime="image/jpeg", created_at=""))
    meta = _write_parquet_dir(tmp_path, [[_prow(i) for i in range(4)]])
    seed_pd12m.seed_from_parquet_fast(meta, 4, d1, vec, emb, page_size=2)
    assert emb.many_calls == [2]            # page1 fully deduped -> no embed; page2 embeds p2,p3


def test_main_metadata_dir_routes_to_parquet(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(seed_pd12m, "build_clients", lambda s: (None, None, None))
    monkeypatch.setattr(seed_pd12m, "seed_from_parquet",
                        lambda path, limit, *a, **kw: seen.update(path=str(path), limit=limit) or 7)
    monkeypatch.setattr(sys, "argv", ["seed_pd12m", "--metadata-dir", str(tmp_path), "--limit", "9"])
    seed_pd12m.main()
    assert seen == {"path": str(tmp_path), "limit": 9}


def test_build_clients_uses_correct_settings_attrs_and_kwargs(monkeypatch):
    from wagmiphotos.common.bge import BgeEmbedder

    monkeypatch.setattr(BgeEmbedder, "from_pretrained", classmethod(lambda cls, model_name: FakeEmbedder()))
    settings = Settings(
        cf_account_id="a", d1_database_id="d", vectorize_index_prefix="wagmiphotos-bge-",
        vectorize_shards=3, cf_api_token="t")
    d1, vectorize, embedder = seed_pd12m.build_clients(settings)
    assert d1 is not None and vectorize is not None and embedder is not None
