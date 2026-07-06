import math
import sys

import pytest

from sharedcache.common.bge import BgeEmbedder

class FakeEncoder:
    def encode(self, texts): return [[3.0, 4.0] for _ in texts]  # un-normalized

def test_text_embed_l2_normalizes_the_contract():
    v = BgeEmbedder(FakeEncoder()).text_embed("a red fox")
    assert math.isclose(v[0], 0.6, abs_tol=1e-6)
    assert math.isclose(v[1], 0.8, abs_tol=1e-6)
    assert math.isclose(math.sqrt(sum(x*x for x in v)), 1.0, abs_tol=1e-6)

def test_text_embed_passes_raw_text_no_prefix():
    seen = {}
    class E:
        def encode(self, texts): seen["texts"] = texts; return [[1.0, 0.0]]
    BgeEmbedder(E()).text_embed("hello world")
    assert seen["texts"] == ["hello world"]   # exact text, no instruction prefix

def test_from_pretrained_missing_dependency_names_the_extra(monkeypatch):
    monkeypatch.setitem(sys.modules, "sentence_transformers", None)  # simulate not installed
    with pytest.raises(ImportError) as e:
        BgeEmbedder.from_pretrained()
    assert "sharedcache-backfill[model]" in str(e.value)
