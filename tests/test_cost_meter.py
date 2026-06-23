from sharedcache.cost_meter import CostMeter
from sharedcache.pricing import price_usd

def test_known_price_lookup():
    assert price_usd("openai", "gpt-image-1") > 0

def test_unknown_price_is_zero():
    assert price_usd("nobody", "nothing") == 0.0

def test_record_hit_accumulates_total():
    m = CostMeter()
    saved = m.record_hit("k1", "asset-1", "openai", "gpt-image-1")
    assert saved == price_usd("openai", "gpt-image-1")
    m.record_hit("k1", "asset-2", "openai", "gpt-image-1")
    assert m.total_saved() == saved * 2
