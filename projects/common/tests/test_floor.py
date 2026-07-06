from wagmiphotos.common.floor import similarity_floor

def test_floor_uses_bge_calibrated_defaults():
    sim_max, sim_min = 0.90, 0.72
    floor = similarity_floor(0.15, sim_max=sim_max, sim_min=sim_min)
    assert floor == sim_max - 0.15 * (sim_max - sim_min)

def test_floor_accepts_custom_bounds():
    assert similarity_floor(0.0, sim_max=0.9, sim_min=0.5) == 0.9
