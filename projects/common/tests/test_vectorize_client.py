import json, httpx, pytest
from wagmiphotos.common.vectorize_client import VectorizeClient

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

def _vectorize(monkeypatch, responses, shards=1, **kw):
    fake = _FakeClient(responses)
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: fake)
    return VectorizeClient("acct", "wagmiphotos-bge-", shards, "tok", **kw), fake

def _ok(result=None):
    return _Resp({"success": True, "result": result or {}})

def test_query_posts_vector_and_parses(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_Resp({"success": True, "result": {"matches": [
        {"id": "a1", "score": 0.31}]}})])
    out = v.query([0.1] * 768, top_k=1)
    assert out == [{"id": "a1", "score": 0.31}]
    url, kw = fake.calls[0]
    assert "wagmiphotos-bge-0/query" in url and kw["json"]["topK"] == 1
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
    from wagmiphotos.common import cf_api
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

# -- sharding: routing, grouping, fan-out + merge ---------------------------
# Shard assignments below (demo-1 -> 0, demo-3 -> 1, pd12m-8492731 -> 2) are
# pinned by contract.json shard_fixtures / test_contract.py, not re-derived here.

def test_upsert_routes_by_shard(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_ok(), _ok()], shards=3)
    v.upsert("demo-1", [0.0] * 768, {})          # fnv1a32 % 3 == 0
    v.upsert("pd12m-8492731", [0.0] * 768, {})   # fnv1a32 % 3 == 2
    assert "wagmiphotos-bge-0/upsert" in fake.calls[0][0]
    assert "wagmiphotos-bge-2/upsert" in fake.calls[1][0]

def test_insert_many_groups_per_shard(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_ok(), _ok()], shards=3)
    v.insert_many([
        {"id": "demo-1", "values": [0.0] * 768, "metadata": {}},  # shard 0
        {"id": "demo-3", "values": [0.0] * 768, "metadata": {}},  # shard 1
    ])
    assert len(fake.calls) == 2  # exactly one REST call per non-empty shard

    shard0_call = next(c for c in fake.calls if "wagmiphotos-bge-0" in c[0])
    shard1_call = next(c for c in fake.calls if "wagmiphotos-bge-1" in c[0])
    assert json.loads(shard0_call[1]["content"].decode().strip())["id"] == "demo-1"
    assert json.loads(shard1_call[1]["content"].decode().strip())["id"] == "demo-3"

def test_insert_many_skips_empty_shards(monkeypatch):
    # All items route to the same shard -> only that shard gets a REST call.
    v, fake = _vectorize(monkeypatch, [_ok()], shards=3)
    v.insert_many([
        {"id": "demo-1", "values": [0.0] * 768, "metadata": {}},
        {"id": "demo-2", "values": [0.0] * 768, "metadata": {}},  # also shard 0
    ])
    assert len(fake.calls) == 1
    assert "wagmiphotos-bge-0" in fake.calls[0][0]

def test_query_fans_out_to_every_shard_and_merges_desc(monkeypatch):
    responses = [
        _ok({"matches": [{"id": "a", "score": 0.91}]}),   # shard 0
        _ok({"matches": [{"id": "c", "score": 0.95}]}),   # shard 1
        _ok({"matches": [{"id": "d", "score": 0.80}]}),   # shard 2
    ]
    v, fake = _vectorize(monkeypatch, responses, shards=3)
    out = v.query([0.0] * 768, top_k=2)
    assert len(fake.calls) == 3  # every shard queried, full top_k each
    # Each shard must be asked for the FULL top_k, not top_k // shards — the
    # merge only re-slices to top_k across the union of per-shard results, so
    # under-asking any shard could silently drop a better match.
    for url, kw in fake.calls:
        assert kw["json"]["topK"] == 2, f"{url} got topK={kw['json']['topK']!r}, expected the full top_k=2"
    assert [m["id"] for m in out] == ["c", "a"]  # merged, sorted desc, sliced to top_k

def test_query_merge_keeps_max_score_when_earlier_shard_scores_higher(monkeypatch):
    # Same id returned by two shards with different scores. The higher score
    # comes from the EARLIER shard (0), the lower one from a LATER shard (1).
    # A last-write-wins merge would wrongly clobber 0.95 with 0.40; max-score
    # merge must keep 0.95.
    responses = [
        _ok({"matches": [{"id": "a", "score": 0.95}]}),   # shard 0: higher
        _ok({"matches": [{"id": "a", "score": 0.40}]}),   # shard 1: lower, same id
    ]
    v, fake = _vectorize(monkeypatch, responses, shards=2)
    out = v.query([0.0] * 768, top_k=1)
    assert out == [{"id": "a", "score": 0.95}]
