from sharedcache.cost_meter import CostMeter

def test_record_hit_returns_flat_price_and_accumulates():
    m = CostMeter(price_usd=0.04)
    assert m.record_hit("caller", "a1") == 0.04
    m.record_hit("caller", "a2")
    assert m.total_saved() == 0.08
