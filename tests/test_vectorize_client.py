import json, httpx
from sharedcache.vectorize_client import VectorizeClient

class _Resp:
    def __init__(self, data, status=200):
        self._d, self.status_code, self.text = data, status, "e"
    def json(self): return self._d

def test_query_posts_vector_and_parses(monkeypatch):
    seen = {}
    def fake_post(url, **kw):
        seen["url"], seen["json"] = url, kw.get("json")
        return _Resp({"success": True, "result": {"matches": [{"id": "a1", "score": 0.31, "metadata": {"source": "pd12m"}}]}})
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    v = VectorizeClient("acct", "idx", "tok")
    out = v.query([0.1] * 768, top_k=1)
    assert out == [{"id": "a1", "score": 0.31, "metadata": {"source": "pd12m"}}]
    assert "idx/query" in seen["url"] and seen["json"]["topK"] == 1

def test_upsert_posts_ndjson(monkeypatch):
    seen = {}
    def fake_post(url, **kw):
        seen["url"], seen["content"] = url, kw.get("content")
        return _Resp({"success": True, "result": {}})
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    v = VectorizeClient("acct", "idx", "tok")
    v.upsert("a1", [0.2] * 768, {"source": "generated"})
    assert "upsert" in seen["url"]
    line = json.loads(seen["content"].decode().strip())
    assert line["id"] == "a1" and line["metadata"] == {"source": "generated"} and len(line["values"]) == 768

def test_insert_many_multiline_ndjson(monkeypatch):
    seen = {}
    def fake_post(url, **kw):
        seen["url"], seen["content"] = url, kw.get("content")
        return _Resp({"success": True, "result": {}})
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    v = VectorizeClient("acct", "idx", "tok")
    v.insert_many([
        {"id": "v1", "values": [0.1] * 768, "metadata": {"source": "a"}},
        {"id": "v2", "values": [0.2] * 768, "metadata": {"source": "b"}}
    ])
    assert "insert" in seen["url"]
    lines = seen["content"].decode().splitlines()
    assert len(lines) == 2
    parsed = [json.loads(line) for line in lines]
    assert {p["id"] for p in parsed} == {"v1", "v2"}
    assert all(len(p["values"]) == 768 for p in parsed)

def test_query_non_200_raises_runtime_error(monkeypatch):
    def fake_post(url, **kw):
        return _Resp({"error": "Internal Server Error"}, status=500)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    v = VectorizeClient("acct", "idx", "tok")
    import pytest
    with pytest.raises(RuntimeError):
        v.query([0.1] * 768)

def test_query_success_false_raises_runtime_error(monkeypatch):
    def fake_post(url, **kw):
        return _Resp({"success": False, "errors": ["boom"]}, status=200)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: type("C", (), {"post": staticmethod(fake_post), "__enter__": lambda s: s, "__exit__": lambda s,*a: False})())
    v = VectorizeClient("acct", "idx", "tok")
    import pytest
    with pytest.raises(RuntimeError):
        v.query([0.1] * 768)
