from sharedcache.common.floor import similarity_floor

def test_floor_uses_clip_calibrated_defaults():
    assert similarity_floor(0.0) == 0.35     # strict -> sim_max
    assert similarity_floor(1.0) == 0.18     # loose  -> sim_min
    mid = similarity_floor(0.5)
    assert 0.18 < mid < 0.35

def test_floor_accepts_custom_bounds():
    assert similarity_floor(0.0, sim_max=0.9, sim_min=0.5) == 0.9
