"""BGE text embeddings (bge-base-en-v1.5). Shared contract with the Worker's
Workers AI BGE: raw text, NO instruction prefix (symmetric similarity), CLS
pooling, L2-normalized, 768-dim. Heavy deps (sentence-transformers/torch) are
imported lazily so the workspace and unit tests stay light."""
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

    @classmethod
    def from_pretrained(cls, model_name: str = BGE_MODEL) -> "BgeEmbedder":
        try:
            from sentence_transformers import SentenceTransformer  # lazy, heavy
        except ImportError as e:
            raise ImportError(
                "sentence-transformers is not installed — real BGE embeddings need "
                "the model extra: pip install 'sharedcache-backfill[model]'") from e

        model = SentenceTransformer(model_name)

        class _STEncoder:
            def encode(self, texts: list[str]) -> list[list[float]]:
                # no prefix (symmetric); normalize for the contract
                return model.encode(texts, normalize_embeddings=True).tolist()

        return cls(_STEncoder())
