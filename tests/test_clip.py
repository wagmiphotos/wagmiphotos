import httpx
from sharedcache.clip import ClipEmbedder

class _Resp:
    def __init__(self, data, status=200):
        self._data, self.status_code, self.text = data, status, "err"
    def json(self):
        return self._data

def test_text_embed_posts_json_and_returns_vector(monkeypatch):
    seen = {}
    def fake_post(url, **kw):
        seen["url"], seen["json"], seen["headers"] = url, kw.get("json"), kw.get("headers")
        return _Resp([0.1] * 768)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    emb = ClipEmbedder("https://clip/text", "https://clip/image", token="tok")
    vec = emb.text_embed("a red fox")
    assert len(vec) == 768
    assert seen["url"] == "https://clip/text"
    assert seen["json"] == {"inputs": "a red fox"}
    assert seen["headers"]["Authorization"] == "Bearer tok"

def test_image_embed_posts_bytes(monkeypatch):
    seen = {}
    def fake_post(url, **kw):
        seen["url"], seen["content"] = url, kw.get("content")
        return _Resp([0.2] * 768)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    emb = ClipEmbedder("https://clip/text", "https://clip/image")
    vec = emb.image_embed(b"PNGBYTES")
    assert len(vec) == 768 and seen["content"] == b"PNGBYTES" and seen["url"] == "https://clip/image"

def test_non_200_raises(monkeypatch):
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(lambda url, **kw: _Resp(None, status=503)), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    emb = ClipEmbedder("https://clip/text", "https://clip/image")
    try:
        emb.text_embed("x"); assert False, "expected RuntimeError"
    except RuntimeError:
        pass
