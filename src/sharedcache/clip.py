import httpx

class ClipEmbedder:
    """CLIP ViT-L/14 text + image embeddings over swappable HTTP endpoints
    (HF Inference API shape by default)."""
    def __init__(self, text_url: str, image_url: str, token: str | None = None, timeout: float = 30.0):
        self._text_url = text_url
        self._image_url = image_url
        self._token = token
        self._timeout = timeout

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    @staticmethod
    def _flatten(data) -> list[float]:
        # HF may return [floats], [[floats]], or {"embedding":[...]}
        if isinstance(data, dict) and "embedding" in data:
            data = data["embedding"]
        if isinstance(data, list) and data and isinstance(data[0], list):
            data = data[0]
        if not (isinstance(data, list) and data and isinstance(data[0], float)):
            raise ValueError(f"Unexpected embedding response: {data!r}")
        return [float(x) for x in data]

    def text_embed(self, text: str) -> list[float]:
        with httpx.Client() as c:
            r = c.post(self._text_url, json={"inputs": text}, headers=self._headers(), timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"CLIP text embed failed ({r.status_code}): {r.text}")
        return self._flatten(r.json())

    def image_embed(self, image_bytes: bytes) -> list[float]:
        with httpx.Client() as c:
            r = c.post(self._image_url, content=image_bytes, headers=self._headers(), timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"CLIP image embed failed ({r.status_code}): {r.text}")
        return self._flatten(r.json())
