"""BGE text embeddings (bge-base-en-v1.5). Shared contract with the Worker's
Workers AI BGE: raw text, NO instruction prefix (symmetric similarity), MEAN
pooling, L2-normalized, 768-dim. Workers AI mean-pools (verified live
2026-07-07: cosine 1.0000 vs local mean pooling on the drift fixtures, only
~0.95-0.98 vs the CLS pooling BGE ships with), so the local side must
mean-pool too — the DEPLOY.md drift check gates this. Heavy deps
(sentence-transformers/torch) are imported lazily so the workspace and unit
tests stay light."""
import math
from typing import Protocol

BGE_MODEL = "BAAI/bge-base-en-v1.5"


class TextEncoder(Protocol):
    def encode(self, texts: list[str]) -> list[list[float]]: ...


def _l2(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


class BgeEmbedder:
    def __init__(self, encoder: TextEncoder):
        self._enc = encoder

    def text_embed(self, text: str) -> list[float]:
        vec = [float(x) for x in self._enc.encode([text])[0]]
        return _l2(vec)  # idempotent; guarantees the L2-normalized contract

    def text_embed_many(self, texts: list[str]) -> list[list[float]]:
        """Batched text_embed: one encode() call for the whole list (much faster
        than per-text on CPU). Same per-vector L2-normalized contract."""
        if not texts:
            return []
        return [_l2([float(x) for x in vec]) for vec in self._enc.encode(texts)]

    @classmethod
    def from_pretrained(cls, model_name: str = BGE_MODEL) -> "BgeEmbedder":
        try:
            from sentence_transformers import SentenceTransformer  # lazy, heavy
        except ImportError as e:
            raise ImportError(
                "sentence-transformers is not installed — real BGE embeddings need "
                "the model extra: pip install 'wagmiphotos-backfill[model]'") from e

        model = SentenceTransformer(model_name)
        # BGE ships CLS pooling, but Workers AI's @cf/baai/bge-base-en-v1.5
        # mean-pools — force mean so both runtimes share one vector space.
        # sentence-transformers >= 5 stores a pooling_mode string; older
        # versions use per-mode boolean flags. Fail loudly if neither is found
        # rather than silently drifting back to CLS.
        flipped = False
        for module in model:
            if hasattr(module, "pooling_mode"):
                module.pooling_mode = "mean"
                flipped = True
            elif hasattr(module, "pooling_mode_cls_token"):
                module.pooling_mode_cls_token = False
                module.pooling_mode_mean_tokens = True
                flipped = True
        if not flipped:
            raise RuntimeError(
                "could not switch the sentence-transformers Pooling module to mean "
                "pooling — the Workers AI parity contract requires it (see DEPLOY.md "
                "drift check)")

        class _STEncoder:
            def encode(self, texts: list[str]) -> list[list[float]]:
                # no prefix (symmetric); normalize for the contract
                out = model.encode(texts, normalize_embeddings=True)
                return out if isinstance(out, list) else out.tolist()

        embedder = cls(_STEncoder())
        embedder._st_model = model  # exposed for pooling-mode verification in tests
        return embedder
