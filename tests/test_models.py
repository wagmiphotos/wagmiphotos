from sharedcache.models import AssetRecord, Generated, GenerationResult

def test_asset_record_roundtrips_fields():
    r = AssetRecord(id="a", prompt="p", url="u", thumb_url=None, provider="openai",
                    model="gpt-image-1", content_hash="h", width=1024, height=1024,
                    mime="image/webp", manifest_url=None, created_at="2026-06-23T00:00:00Z")
    assert r.width == 1024 and r.provider == "openai"

def test_generation_result_holds_outcome():
    r = AssetRecord(id="a", prompt="p", url="u", thumb_url=None, provider="o", model="m",
                    content_hash="h", width=1, height=1, mime="image/webp",
                    manifest_url=None, created_at="t")
    gr = GenerationResult(record=r, result="hit", similarity=0.93, cost_saved_usd=0.04)
    assert gr.result == "hit" and gr.cost_saved_usd == 0.04
