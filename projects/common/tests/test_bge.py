import math
import sys

import pytest

from wagmiphotos.common.bge import BgeEmbedder

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
    assert "wagmiphotos-backfill[model]" in str(e.value)

def test_from_pretrained_forces_mean_pooling(monkeypatch):
    # Workers AI's BGE mean-pools (verified live: cosine 1.0000 vs local mean,
    # ~0.95-0.98 vs the CLS pooling BGE ships with). from_pretrained must flip
    # the sentence-transformers Pooling module to mean or edge and backfill
    # vectors land in different spaces.
    class FakePoolingV5:  # sentence-transformers >= 5: single string attr
        pooling_mode = "cls"
    class FakePoolingLegacy:  # older API: boolean flags
        pooling_mode_cls_token = True
        pooling_mode_mean_tokens = False
    class FakeST:
        pooling_cls = FakePoolingV5
        def __init__(self, name): self.modules = [object(), type(self).pooling_cls()]
        def __iter__(self): return iter(self.modules)
        def encode(self, texts, normalize_embeddings=True): return [[1.0, 0.0]]
    fake_module = type(sys)("sentence_transformers")
    fake_module.SentenceTransformer = FakeST
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_module)

    emb = BgeEmbedder.from_pretrained("BAAI/bge-base-en-v1.5")
    assert emb._st_model.modules[1].pooling_mode == "mean"

    FakeST.pooling_cls = FakePoolingLegacy
    emb = BgeEmbedder.from_pretrained("BAAI/bge-base-en-v1.5")
    pooling = emb._st_model.modules[1]
    assert pooling.pooling_mode_cls_token is False
    assert pooling.pooling_mode_mean_tokens is True

def test_from_pretrained_raises_when_pooling_module_not_found(monkeypatch):
    class FakeST:
        def __init__(self, name): pass
        def __iter__(self): return iter([object()])  # no pooling module at all
        def encode(self, texts, normalize_embeddings=True): return [[1.0, 0.0]]
    fake_module = type(sys)("sentence_transformers")
    fake_module.SentenceTransformer = FakeST
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_module)
    with pytest.raises(RuntimeError, match="mean"):
        BgeEmbedder.from_pretrained("BAAI/bge-base-en-v1.5")
