import pytest
from sharedcache.embedder import HuggingFaceClipEmbedder

class MockResponse:
    def __init__(self, json_data, status_code):
        self.json_data = json_data
        self.status_code = status_code
        self.text = "Mock Error Details"

    def json(self):
        return self.json_data

def test_hf_clip_embedder_success(monkeypatch):
    called_url = None
    called_headers = None
    called_json = None

    def mock_post(self, url, headers=None, json=None, timeout=None):
        nonlocal called_url, called_headers, called_json
        called_url = url
        called_headers = headers
        called_json = json
        # Mock standard CLIP float output
        return MockResponse([0.1, 0.2, 0.3], 200)

    import httpx
    monkeypatch.setattr(httpx.Client, "post", mock_post)

    embedder = HuggingFaceClipEmbedder(api_key="my-hf-token", model="my-custom/model", dims=3)
    vec = embedder.embed("a test prompt")

    assert vec == [0.1, 0.2, 0.3]
    assert called_url == "https://api-inference.huggingface.co/models/my-custom/model"
    assert called_headers["Authorization"] == "Bearer my-hf-token"
    assert called_json == {"inputs": "a test prompt"}

def test_hf_clip_embedder_batch_success(monkeypatch):
    def mock_post(self, url, headers=None, json=None, timeout=None):
        # Mock CLIP batch output shape [[0.1, 0.2]]
        return MockResponse([[0.1, 0.2]], 200)

    import httpx
    monkeypatch.setattr(httpx.Client, "post", mock_post)

    embedder = HuggingFaceClipEmbedder()
    vec = embedder.embed("another prompt")
    assert vec == [0.1, 0.2]

def test_hf_clip_embedder_model_loading_retry(monkeypatch):
    def mock_post(self, url, headers=None, json=None, timeout=None):
        # Mock HF model loading state
        return MockResponse({"error": "Model is loading"}, 503)

    import httpx
    monkeypatch.setattr(httpx.Client, "post", mock_post)

    embedder = HuggingFaceClipEmbedder()
    with pytest.raises(RuntimeError) as exc_info:
        embedder.embed("waiting...")
    assert "loading the model" in str(exc_info.value)
