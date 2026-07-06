from wagmiphotos.common import models
from wagmiphotos.common.models import AssetRecord, Generated

def test_asset_record_fields():
    r = AssetRecord(id="1", prompt="p", url="u", thumb_url=None, medium_url=None,
                    model_used="m", source="generated", source_id=None, content_hash="h",
                    width=1, height=1, mime="image/webp", manifest_url=None, created_at="t")
    assert r.locally_cached is True and r.source == "generated"

def test_generated_fields():
    g = Generated(url="u", content_hash="h", width=1, height=1, mime="image/webp",
                  model_used="m", source="generated", manifest_json="{}", manifest_hash="x",
                  storage_key="k")
    assert g.model_used == "m"

def test_generation_result_is_gone():
    # dead code: nothing produced or consumed it (the worker never returns
    # per-request generation outcomes)
    assert not hasattr(models, "GenerationResult")
