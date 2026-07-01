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
        from google.genai import types
        resp = self._client.models.embed_content(
            model=self._model,
            contents=text,
            config=types.EmbedContentConfig(output_dimensionality=self.dims),
        )
        return list(resp.embeddings[0].values)


class HuggingFaceClipEmbedder:
    """Real embedder using Hugging Face Inference API for CLIP embeddings."""
    def __init__(self, api_key: str | None = None, model: str = "sentence-transformers/clip-ViT-L-14", dims: int = 768) -> None:
        import httpx
        self._client = httpx.Client()
        self._api_key = api_key
        self._model = model
        self._url = f"https://api-inference.huggingface.co/models/{model}"
        self.dims = dims

    def embed(self, text: str) -> list[float]:
        headers = {}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        resp = self._client.post(
            self._url,
            headers=headers,
            json={"inputs": text},
            timeout=15.0
        )
        if resp.status_code != 200:
            if resp.status_code == 503:
                raise RuntimeError(f"Hugging Face Inference API is loading the model: {resp.text}")
            raise RuntimeError(f"Hugging Face Inference API failed ({resp.status_code}): {resp.text}")
        
        res = resp.json()
        if isinstance(res, list) and len(res) > 0:
            if isinstance(res[0], float):
                return res
            if isinstance(res[0], list) and len(res[0]) > 0 and isinstance(res[0][0], float):
                return res[0]
        raise ValueError(f"Unexpected response format from Hugging Face: {res}")
