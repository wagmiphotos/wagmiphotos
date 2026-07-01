import importlib.util, pathlib
from sharedcache.models import AssetRecord
from tests.fakes import FakeD1, FakeVectorize

_spec = importlib.util.spec_from_file_location(
    "seed_pd12m", pathlib.Path(__file__).parent.parent / "scripts" / "seed_pd12m.py")
seed_pd12m = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(seed_pd12m)

def test_seed_rows_inserts_d1_and_vectorize():
    d1, vec = FakeD1(), FakeVectorize()
    rows = [{"id": "7", "prompt": "a fox", "url": "https://ext/fox.jpg",
             "width": 100, "height": 80, "mime": "image/jpeg", "embedding": [0.1] * 768}]
    n = seed_pd12m.seed_rows(rows, d1, vec)
    assert n == 1
    rec = d1.inserted[0]
    assert isinstance(rec, AssetRecord) and rec.source == "pd12m" and rec.source_id == "7"
    assert rec.locally_cached is False and rec.url == "https://ext/fox.jpg" and rec.source_url == "https://ext/fox.jpg"
    assert list(vec.vectors)[0] == rec.id and vec.vectors[rec.id]["metadata"] == {"source": "pd12m"}
