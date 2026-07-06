def similarity_floor(cache_tolerance: float, *, sim_max: float = 0.35, sim_min: float = 0.18) -> float:
    """Map cache_tolerance (0..1) to a minimum cosine similarity on the BGE
    text-to-text scale (high absolute values, since prompts are compared
    against prompts). 0 = strict (sim_max), 1 = loose (sim_min)."""
    t = min(1.0, max(0.0, cache_tolerance))
    return sim_max - t * (sim_max - sim_min)
