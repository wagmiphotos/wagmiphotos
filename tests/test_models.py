from sharedcache.models import AssetRecord, Generated, GenerationResult

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

def test_generation_result_holds_outcome():
    r = AssetRecord(id="a", prompt="p", url="u", thumb_url=None, medium_url=None,
                    model_used="m", source="generated", source_id=None, content_hash="h",
                    width=1, height=1, mime="image/webp", manifest_url=None, created_at="t")
    gr = GenerationResult(record=r, result="hit", similarity=0.93, cost_saved_usd=0.04)
    assert gr.result == "hit" and gr.cost_saved_usd == 0.04
