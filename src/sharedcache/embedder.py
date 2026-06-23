import hashlib
import math
from typing import Protocol, runtime_checkable

@runtime_checkable
class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...

class HashEmbedder:
    """Deterministic, dependency-free embedder for tests/local fallback."""
    def __init__(self, dims: int = 768):
        self.dims = dims

    def embed(self, text: str) -> list[float]:
        vec: list[float] = []
        counter = 0
        while len(vec) < self.dims:
            h = hashlib.sha256(f"{text}:{counter}".encode()).digest()
            for b in h:
                vec.append((b / 255.0) * 2.0 - 1.0)
                if len(vec) == self.dims:
                    break
            counter += 1
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

class GeminiEmbedder:
    """Real embedder using Google GenAI text embeddings."""
    def __init__(self, api_key: str, dims: int = 768, model: str = "text-embedding-004"):
        from google import genai
        self._client = genai.Client(api_key=api_key)
        self._model = model
        self.dims = dims

    def embed(self, text: str) -> list[float]:
        resp = self._client.models.embed_content(model=self._model, contents=text)
        return list(resp.embeddings[0].values)
