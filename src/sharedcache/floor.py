def similarity_floor(cache_tolerance: float, *, sim_max: float = 0.98, sim_min: float = 0.70) -> float:
    t = min(1.0, max(0.0, cache_tolerance))
    return sim_max - t * (sim_max - sim_min)
