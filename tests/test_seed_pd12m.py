import importlib.util, pathlib
from sharedcache.config import Settings
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

def test_build_clients_uses_correct_settings_attrs_and_kwargs():
    settings = Settings(
        cf_account_id="a", d1_database_id="d", vectorize_index_name="i",
        cf_api_token="t", clip_text_embed_url="http://t", clip_image_embed_url="http://i")
    d1, vectorize, clip = seed_pd12m.build_clients(settings)
    assert d1 is not None and vectorize is not None and clip is not None
