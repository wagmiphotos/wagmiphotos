from wagmiphotos.common import models
from wagmiphotos.common.models import AssetRecord, Generated

def test_asset_record_fields():
    r = AssetRecord(id="1", prompt="p", model_used="m", source="generated", source_id=None,
                    content_hash="h", width=1, height=1, mime="image/webp", created_at="t")
    assert r.locally_cached is True and r.source == "generated"


def test_asset_record_has_no_stored_urls():
    # Derived-URL design: asset URLs come from (id, locally_cached, source_url),
    # not stored columns.
    import dataclasses
    fields = {f.name for f in dataclasses.fields(AssetRecord)}
    assert not (fields & {"url", "thumb_url", "medium_url", "manifest_url"})

def test_generated_fields():
    g = Generated(url="u", content_hash="h", width=1, height=1, mime="image/webp",
                  model_used="m", source="generated", manifest_json="{}", manifest_hash="x",
                  storage_key="k", provider="gmicloud")
    assert g.model_used == "m"
    assert g.provider == "gmicloud"


def test_asset_record_carries_price_and_provider():
    # Generated assets record the price paid and the backend that made them, so
    # the row stays self-describing even after the price constant or model changes.
    r = AssetRecord(id="1", prompt="p", model_used="Z-Image-Turbo", source="generated",
                    source_id=None, content_hash="h", width=1, height=1, mime="image/webp",
                    created_at="t", price_usd=0.01, provider="gmicloud")
    assert r.price_usd == 0.01 and r.provider == "gmicloud"
    # rehosted/seed assets have no cost and no provider — the fields default away.
    seed = AssetRecord(id="2", prompt="p", model_used=None, source="pd12m", source_id="s",
                       content_hash="h", width=1, height=1, mime="image/webp", created_at="t")
    assert seed.price_usd is None and seed.provider is None

def test_generation_result_is_gone():
    # dead code: nothing produced or consumed it (the worker never returns
    # per-request generation outcomes)
    assert not hasattr(models, "GenerationResult")
