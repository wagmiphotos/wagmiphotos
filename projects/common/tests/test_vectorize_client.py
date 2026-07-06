import json, httpx, pytest
from sharedcache.common.vectorize_client import VectorizeClient

class _Resp:
    def __init__(self, data, status=200):
        self._d, self.status_code, self.text = data, status, "e"
    def json(self): return self._d

class _FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.closed = False
    def post(self, url, **kw):
        self.calls.append((url, kw))
        return self.responses.pop(0)
    def close(self):
        self.closed = True

def _vectorize(monkeypatch, responses, **kw):
    fake = _FakeClient(responses)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: fake)
    return VectorizeClient("acct", "idx", "tok", **kw), fake

def test_query_posts_vector_and_parses(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_Resp({"success": True, "result": {"matches": [
        {"id": "a1", "score": 0.31}]}})])
    out = v.query([0.1] * 768, top_k=1)
    assert out == [{"id": "a1", "score": 0.31}]
    url, kw = fake.calls[0]
    assert "idx/query" in url and kw["json"]["topK"] == 1
    assert kw["json"]["returnMetadata"] == "none"  # only id/score are consumed

def test_client_is_shared_across_requests(monkeypatch):
    ok = {"success": True, "result": {"matches": []}}
    v, fake = _vectorize(monkeypatch, [_Resp(ok), _Resp(ok)])
    v.query([0.1] * 768)
    v.query([0.1] * 768)
    assert len(fake.calls) == 2  # both went through the one shared client

def test_upsert_posts_ndjson(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_Resp({"success": True, "result": {}})])
    v.upsert("a1", [0.2] * 768, {"source": "generated"})
    url, kw = fake.calls[0]
    assert "upsert" in url
    line = json.loads(kw["content"].decode().strip())
    assert line["id"] == "a1" and line["metadata"] == {"source": "generated"} and len(line["values"]) == 768

def test_upsert_rejects_wrong_vector_length(monkeypatch):
    v, fake = _vectorize(monkeypatch, [])
    with pytest.raises(ValueError) as e:
        v.upsert("a1", [0.2] * 8, {"source": "generated"})
    assert "8" in str(e.value) and "768" in str(e.value)
    assert fake.calls == []  # rejected before hitting the API

def test_insert_many_rejects_wrong_vector_length(monkeypatch):
    v, fake = _vectorize(monkeypatch, [])
    with pytest.raises(ValueError):
        v.insert_many([{"id": "v1", "values": [0.1] * 767, "metadata": {}}])
    assert fake.calls == []

def test_dims_configurable(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_Resp({"success": True, "result": {}})], dims=8)
    v.upsert("a1", [0.2] * 8, {})
    assert len(fake.calls) == 1

def test_insert_many_multiline_ndjson(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_Resp({"success": True, "result": {}})])
    v.insert_many([
        {"id": "v1", "values": [0.1] * 768, "metadata": {"source": "a"}},
        {"id": "v2", "values": [0.2] * 768, "metadata": {"source": "b"}}
    ])
    url, kw = fake.calls[0]
    assert "insert" in url
    lines = kw["content"].decode().splitlines()
    assert len(lines) == 2
    parsed = [json.loads(line) for line in lines]
    assert {p["id"] for p in parsed} == {"v1", "v2"}
    assert all(len(p["values"]) == 768 for p in parsed)

def test_query_non_200_raises_runtime_error(monkeypatch):
    from sharedcache.common import cf_api
    monkeypatch.setattr(cf_api.time, "sleep", lambda s: None)  # 500s are retried
    v, fake = _vectorize(monkeypatch, [_Resp({"error": "Internal Server Error"}, status=500)] * 3)
    with pytest.raises(RuntimeError):
        v.query([0.1] * 768)

def test_query_success_false_raises_runtime_error(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_Resp({"success": False, "errors": ["boom"]}, status=200)])
    with pytest.raises(RuntimeError):
        v.query([0.1] * 768)

def test_close_closes_shared_client(monkeypatch):
    v, fake = _vectorize(monkeypatch, [])
    v.close()
    assert fake.closed is True
