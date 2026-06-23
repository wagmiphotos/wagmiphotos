from sharedcache.embedder import HashEmbedder

def test_hash_embedder_is_deterministic_and_sized():
    e = HashEmbedder(dims=768)
    a = e.embed("a cozy cafe")
    b = e.embed("a cozy cafe")
    assert len(a) == 768
    assert a == b

def test_hash_embedder_differs_by_text():
    e = HashEmbedder(dims=64)
    assert e.embed("cat") != e.embed("dog")

def test_hash_embedder_is_unit_norm():
    e = HashEmbedder(dims=64)
    v = e.embed("anything")
    assert abs(sum(x * x for x in v) - 1.0) < 1e-6
