# Data Foundation + Python Backfill Worker — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the D1 schema and the standalone Python backfill worker — Cloudflare REST clients (D1 + Vectorize), a CLIP text/image embedder, a demand-ranked generate pass with re-check-before-generate, a PD12M→B2 rehost pass, and a PD12M seeder — all offline-testable with fakes.

**Architecture:** The backfill is a plain Python process that reaches D1 and Vectorize over the Cloudflare REST API and reuses the existing Genblaze generator, `derive_sizes` processor, and B2 storage. D1 access is a small repository (typed methods, not raw SQL at call sites) so the worker is testable against an in-memory fake. Generation and rehost are two passes per tick; the generate pass re-queries Vectorize before generating so nothing is built twice.

**Tech Stack:** Python 3.11+, httpx, Pillow, Genblaze SDK (GMI Cloud), pytest + pytest-asyncio. Targets Cloudflare D1 + Vectorize (v2 REST) and Backblaze B2.

**Spec:** `docs/superpowers/specs/2026-07-01-cloudflare-edge-cache-design.md` (§4 data model, §6 backfill, §7 seed, §3 embeddings, §9 env).

**Plan 2 (separate):** the Cloudflare Worker (TypeScript) request path — not in this plan.

## Global Constraints

- Python `>=3.11`; package stays offline-importable (lazy-import genblaze, and construct httpx clients inside methods so import never needs network/creds).
- All behaviour offline-testable with `StubGenerator`, `InMemoryStorage`, and in-memory D1/Vectorize fakes. No test performs real network I/O.
- Storage stays Backblaze **B2**. Generation defaults to **gmicloud**. Assets carry generic `model_used` + `source` (from the branch's existing model).
- Embedding space is **CLIP ViT-L/14, 768-dim, cosine**. Stored vectors are image-space (PD12M image vectors + CLIP-image of generated images); query/re-check vectors are CLIP-**text** of the prompt.
- Similarity floor is CLIP-cross-modal-calibrated: `FLOOR_SIM_MAX=0.35`, `FLOOR_SIM_MIN=0.18` defaults, env-overridable.
- D1 is SQLite dialect (no booleans → `INTEGER 0/1`; no `vector`).
- Every task ends green: `uv run pytest -q` passes. Commit after every task.
- Reuse, don't reinvent: `generator.py`, `processor.derive_sizes`, `storage.py` (B2), `models.AssetRecord`, `embedder.HuggingFaceClipEmbedder` already exist on this branch.

## File Structure

**Create:**
- `worker/migrations/0001_init.sql` — D1 schema (assets, queries, api_keys) — shared with Plan 2.
- `src/sharedcache/clip.py` — `ClipEmbedder` (`text_embed`, `image_embed`) over the CLIP HTTP endpoints.
- `src/sharedcache/d1_client.py` — `D1Client` repository (typed methods over the D1 REST `query` primitive) + `QueryRow` dataclass.
- `src/sharedcache/vectorize_client.py` — `VectorizeClient` (`query`, `upsert`, `insert_many`).
- `src/sharedcache/backfill.py` — `BackfillWorker` (`generate_pass`, `rehost_pass`, `tick`, `run`) + `__main__` entry.
- `tests/fakes.py` — `FakeD1`, `FakeVectorize` implementing the client interfaces in-memory.
- `tests/test_clip.py`, `tests/test_d1_client.py`, `tests/test_vectorize_client.py`, `tests/test_backfill.py`, `tests/test_d1_migration.py`, `tests/test_seed_pd12m.py`.
- `Dockerfile` — container for the GMI Hermes agentbox.

**Modify:**
- `src/sharedcache/config.py` — add CF/backfill/floor settings.
- `src/sharedcache/floor.py` — recalibrate defaults + accept env-driven bounds.
- `scripts/seed_pd12m.py` — rewrite to bulk-seed Vectorize + D1.
- `.env.example` — new env vars.

---

## Task 1: Config + recalibrated floor

**Files:**
- Modify: `src/sharedcache/config.py`, `src/sharedcache/floor.py`
- Test: `tests/test_config.py`, `tests/test_floor.py`

**Interfaces:**
- Produces settings: `cf_account_id`, `cf_api_token`, `d1_database_id`, `vectorize_index_name`, `clip_text_embed_url`, `clip_image_embed_url`, `clip_embed_token` (all `str | None`), `floor_sim_max=0.35`, `floor_sim_min=0.18` (float), plus reuse of existing `worker_batch_size`, `worker_max_spend_usd`, `worker_interval_seconds`, `image_price_usd`, `gmicloud_api_key`, B2 fields.
- Produces: `similarity_floor(cache_tolerance, *, sim_max=0.35, sim_min=0.18) -> float`.

- [ ] **Step 1: Write the failing config test** — append to `tests/test_config.py`:

```python
def test_cf_and_floor_defaults(monkeypatch):
    for k in ("CF_ACCOUNT_ID","CF_API_TOKEN","D1_DATABASE_ID","VECTORIZE_INDEX_NAME",
              "CLIP_TEXT_EMBED_URL","CLIP_IMAGE_EMBED_URL","CLIP_EMBED_TOKEN",
              "FLOOR_SIM_MAX","FLOOR_SIM_MIN"):
        monkeypatch.delenv(k, raising=False)
    from sharedcache.config import Settings
    s = Settings(_env_file=None)
    assert s.cf_account_id is None and s.d1_database_id is None
    assert s.vectorize_index_name is None and s.clip_text_embed_url is None
    assert s.floor_sim_max == 0.35 and s.floor_sim_min == 0.18
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_config.py::test_cf_and_floor_defaults -v`

- [ ] **Step 3: Add settings** — append to `Settings` in `src/sharedcache/config.py`:

```python
    cf_account_id: str | None = None
    cf_api_token: str | None = None
    d1_database_id: str | None = None
    vectorize_index_name: str | None = None
    clip_text_embed_url: str | None = None
    clip_image_embed_url: str | None = None
    clip_embed_token: str | None = None
    floor_sim_max: float = 0.35
    floor_sim_min: float = 0.18
```

- [ ] **Step 4: Write the failing floor test** — replace the body of `tests/test_floor.py` with:

```python
from sharedcache.floor import similarity_floor

def test_floor_uses_clip_calibrated_defaults():
    assert similarity_floor(0.0) == 0.35     # strict -> sim_max
    assert similarity_floor(1.0) == 0.18     # loose  -> sim_min
    mid = similarity_floor(0.5)
    assert 0.18 < mid < 0.35

def test_floor_accepts_custom_bounds():
    assert similarity_floor(0.0, sim_max=0.9, sim_min=0.5) == 0.9
```

- [ ] **Step 5: Run — FAIL** (old defaults were 0.98/0.70). `uv run pytest tests/test_floor.py -v`

- [ ] **Step 6: Recalibrate** `src/sharedcache/floor.py`:

```python
def similarity_floor(cache_tolerance: float, *, sim_max: float = 0.35, sim_min: float = 0.18) -> float:
    """Map cache_tolerance (0..1) to a minimum cosine similarity on the CLIP
    cross-modal scale (low absolute values). 0 = strict (sim_max), 1 = loose (sim_min)."""
    t = min(1.0, max(0.0, cache_tolerance))
    return sim_max - t * (sim_max - sim_min)
```

- [ ] **Step 7: Run both — PASS.** `uv run pytest tests/test_config.py tests/test_floor.py -q`

- [ ] **Step 8: Commit**

```bash
git add src/sharedcache/config.py src/sharedcache/floor.py tests/test_config.py tests/test_floor.py
git commit -m "feat: CF/backfill config + CLIP-calibrated similarity floor"
```

---

## Task 2: CLIP embedder (text + image)

**Files:**
- Create: `src/sharedcache/clip.py`, `tests/test_clip.py`

**Interfaces:**
- Produces: `ClipEmbedder(text_url, image_url, token=None)` with `text_embed(text: str) -> list[float]` and `image_embed(image_bytes: bytes) -> list[float]`. Both POST to their endpoint (HF Inference shape: text sends `{"inputs": text}` JSON; image sends raw bytes) and return a flat 768-float list. Non-200 raises `RuntimeError`.

- [ ] **Step 1: Write the failing tests** — `tests/test_clip.py`:

```python
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
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_clip.py -v`

- [ ] **Step 3: Implement `src/sharedcache/clip.py`:**

```python
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
```

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_clip.py -q`

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/clip.py tests/test_clip.py
git commit -m "feat: CLIP text+image embedder over swappable HTTP endpoints"
```

---

## Task 3: D1 REST repository client

**Files:**
- Create: `src/sharedcache/d1_client.py`, and add `FakeD1` to `tests/fakes.py`
- Test: `tests/test_d1_client.py`

**Interfaces:**
- Produces `QueryRow` dataclass: `normalized_prompt: str, original_prompt: str, count: int`.
- Produces `D1Client(account_id, database_id, api_token)` with methods:
  - `pending_queries(limit: int) -> list[QueryRow]`
  - `mark_query_built(normalized_prompt: str, asset_id: str) -> None`
  - `insert_asset(rec: AssetRecord) -> None`
  - `assets_needing_rehost(limit: int) -> list[AssetRecord]`
  - `update_asset_urls(asset_id, *, url, medium_url, thumb_url, width, height, mime, locally_cached) -> None`
- Produces `FakeD1` in `tests/fakes.py` implementing the same five methods over in-memory lists (consumed by Task 6 tests).

- [ ] **Step 1: Write the failing tests** — `tests/test_d1_client.py` (mock the low-level `_query`):

```python
from sharedcache.d1_client import D1Client, QueryRow
from sharedcache.models import AssetRecord

def _client(monkeypatch, rows=None):
    calls = []
    c = D1Client("acct", "db", "token")
    def fake_query(sql, params=None):
        calls.append((sql, params or []))
        return rows.pop(0) if rows else []
    monkeypatch.setattr(c, "_query", fake_query)
    return c, calls

def test_pending_queries_orders_and_maps(monkeypatch):
    rows = [[{"normalized_prompt": "a fox", "original_prompt": "A Fox", "count": 5}]]
    c, calls = _client(monkeypatch, rows)
    out = c.pending_queries(10)
    assert out == [QueryRow("a fox", "A Fox", 5)]
    sql, params = calls[0]
    assert "status='pending'" in sql and "ORDER BY count DESC" in sql and params == [10]

def test_mark_query_built_sends_update(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_query_built("a fox", "asset1")
    sql, params = calls[0]
    assert "UPDATE queries" in sql and "status='built'" in sql
    assert params == ["asset1", "a fox"]

def test_insert_asset_binds_all_columns(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    rec = AssetRecord(id="i1", prompt="p", url="u", thumb_url=None, medium_url=None,
                      model_used="m", source="generated", source_id=None, content_hash="h",
                      width=1, height=2, mime="image/webp", manifest_url=None, created_at="t",
                      source_url=None, locally_cached=True)
    c.insert_asset(rec)
    sql, params = calls[0]
    assert "INSERT INTO assets" in sql
    assert params[0] == "i1" and 1 in params and "generated" in params

def test_assets_needing_rehost_maps(monkeypatch):
    rows = [[{"id": "i1", "prompt": "p", "source": "pd12m", "source_id": "7",
              "thumb_url": None, "medium_url": None, "url": "https://ext/x.jpg",
              "model_used": "clip-vit-l-14", "content_hash": "pd12m-7", "width": 10, "height": 20,
              "mime": "image/jpeg", "source_url": "https://ext/x.jpg", "locally_cached": 0}]]
    c, calls = _client(monkeypatch, rows)
    out = c.assets_needing_rehost(5)
    assert len(out) == 1 and out[0].id == "i1" and out[0].locally_cached is False
    assert out[0].source_url == "https://ext/x.jpg"

def test_update_asset_urls_binds(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.update_asset_urls("i1", url="b/large", medium_url="b/med", thumb_url="b/thumb",
                        width=3, height=4, mime="image/webp", locally_cached=True)
    sql, params = calls[0]
    assert "UPDATE assets" in sql and "locally_cached" in sql
    assert params[-1] == "i1" and 1 in params  # locally_cached True -> 1
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_d1_client.py -v`

- [ ] **Step 3: Implement `src/sharedcache/d1_client.py`:**

```python
from dataclasses import dataclass
import httpx
from sharedcache.models import AssetRecord

@dataclass
class QueryRow:
    normalized_prompt: str
    original_prompt: str
    count: int

_API = "https://api.cloudflare.com/client/v4"

class D1Client:
    def __init__(self, account_id: str, database_id: str, api_token: str, timeout: float = 30.0):
        self._url = f"{_API}/accounts/{account_id}/d1/database/{database_id}/query"
        self._token = api_token
        self._timeout = timeout

    def _query(self, sql: str, params: list | None = None) -> list[dict]:
        with httpx.Client() as c:
            r = c.post(self._url, headers={"Authorization": f"Bearer {self._token}"},
                       json={"sql": sql, "params": params or []}, timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"D1 query failed ({r.status_code}): {r.text}")
        body = r.json()
        if not body.get("success", False):
            raise RuntimeError(f"D1 query error: {body.get('errors')}")
        return body["result"][0]["results"]

    def pending_queries(self, limit: int) -> list[QueryRow]:
        rows = self._query(
            "SELECT normalized_prompt, original_prompt, count FROM queries "
            "WHERE status='pending' ORDER BY count DESC LIMIT ?", [limit])
        return [QueryRow(r["normalized_prompt"], r["original_prompt"], int(r["count"])) for r in rows]

    def mark_query_built(self, normalized_prompt: str, asset_id: str) -> None:
        self._query("UPDATE queries SET status='built', last_asset_id=? WHERE normalized_prompt=?",
                    [asset_id, normalized_prompt])

    def insert_asset(self, rec: AssetRecord) -> None:
        self._query(
            "INSERT INTO assets (id, prompt, source, source_id, thumb_url, medium_url, url, "
            "model_used, content_hash, width, height, mime, source_url, locally_cached) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [rec.id, rec.prompt, rec.source, rec.source_id, rec.thumb_url, rec.medium_url, rec.url,
             rec.model_used, rec.content_hash, rec.width, rec.height, rec.mime, rec.source_url,
             1 if rec.locally_cached else 0])

    def assets_needing_rehost(self, limit: int) -> list[AssetRecord]:
        rows = self._query(
            "SELECT id, prompt, source, source_id, thumb_url, medium_url, url, model_used, "
            "content_hash, width, height, mime, source_url, locally_cached FROM assets "
            "WHERE locally_cached=0 LIMIT ?", [limit])
        return [AssetRecord(
            id=r["id"], prompt=r["prompt"], url=r["url"], thumb_url=r["thumb_url"],
            medium_url=r["medium_url"], model_used=r["model_used"], source=r["source"],
            source_id=r["source_id"], content_hash=r["content_hash"], width=r["width"],
            height=r["height"], mime=r["mime"], manifest_url=None, created_at="",
            source_url=r["source_url"], locally_cached=bool(r["locally_cached"])) for r in rows]

    def update_asset_urls(self, asset_id, *, url, medium_url, thumb_url, width, height, mime, locally_cached):
        self._query(
            "UPDATE assets SET url=?, medium_url=?, thumb_url=?, width=?, height=?, mime=?, "
            "locally_cached=? WHERE id=?",
            [url, medium_url, thumb_url, width, height, mime, 1 if locally_cached else 0, asset_id])
```

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_d1_client.py -q`

- [ ] **Step 5: Add `FakeD1` to `tests/fakes.py`** (create the file):

```python
from sharedcache.d1_client import QueryRow

class FakeD1:
    def __init__(self):
        self.pending: list[QueryRow] = []
        self.assets: dict[str, dict] = {}     # id -> asset fields
        self.rehost: list = []                # AssetRecord needing rehost
        self.built: list[tuple[str, str]] = []
        self.inserted: list = []
        self.url_updates: list[tuple] = []
    def pending_queries(self, limit):
        return self.pending[:limit]
    def mark_query_built(self, normalized_prompt, asset_id):
        self.built.append((normalized_prompt, asset_id))
        self.pending = [q for q in self.pending if q.normalized_prompt != normalized_prompt]
    def insert_asset(self, rec):
        self.inserted.append(rec); self.assets[rec.id] = rec
    def assets_needing_rehost(self, limit):
        return self.rehost[:limit]
    def update_asset_urls(self, asset_id, **kw):
        self.url_updates.append((asset_id, kw))
        self.rehost = [a for a in self.rehost if a.id != asset_id]
```

- [ ] **Step 6: Commit**

```bash
git add src/sharedcache/d1_client.py tests/test_d1_client.py tests/fakes.py
git commit -m "feat: D1 REST repository client + in-memory fake"
```

---

## Task 4: Vectorize REST client

**Files:**
- Create: `src/sharedcache/vectorize_client.py`, add `FakeVectorize` to `tests/fakes.py`
- Test: `tests/test_vectorize_client.py`

**Interfaces:**
- Produces `VectorizeClient(account_id, index_name, api_token)` with:
  - `query(values: list[float], top_k: int = 1) -> list[dict]` → `[{"id","score","metadata"}]`
  - `upsert(id: str, values: list[float], metadata: dict) -> None`
  - `insert_many(vectors: list[dict]) -> None` (each `{"id","values","metadata"}`, ndjson body)
- Produces `FakeVectorize` in `tests/fakes.py`: `query` returns the highest-cosine stored vector; `upsert`/`insert_many` store; a `set_score(id, score)` test hook to force scores.

- [ ] **Step 1: Write the failing tests** — `tests/test_vectorize_client.py` (mock httpx at method level):

```python
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
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_vectorize_client.py -v`

- [ ] **Step 3: Implement `src/sharedcache/vectorize_client.py`:**

```python
import json
import httpx

_API = "https://api.cloudflare.com/client/v4"

class VectorizeClient:
    def __init__(self, account_id: str, index_name: str, api_token: str, timeout: float = 30.0):
        self._base = f"{_API}/accounts/{account_id}/vectorize/v2/indexes/{index_name}"
        self._token = api_token
        self._timeout = timeout

    def _headers(self, content_type: str = "application/json") -> dict:
        return {"Authorization": f"Bearer {self._token}", "Content-Type": content_type}

    def query(self, values: list[float], top_k: int = 1) -> list[dict]:
        with httpx.Client() as c:
            r = c.post(f"{self._base}/query", headers=self._headers(),
                       json={"vector": values, "topK": top_k, "returnMetadata": "all"},
                       timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"Vectorize query failed ({r.status_code}): {r.text}")
        return r.json()["result"]["matches"]

    def _ndjson(self, path: str, vectors: list[dict]) -> None:
        body = "\n".join(json.dumps(v) for v in vectors).encode()
        with httpx.Client() as c:
            r = c.post(f"{self._base}/{path}", headers=self._headers("application/x-ndjson"),
                       content=body, timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"Vectorize {path} failed ({r.status_code}): {r.text}")

    def upsert(self, id: str, values: list[float], metadata: dict) -> None:
        self._ndjson("upsert", [{"id": id, "values": values, "metadata": metadata}])

    def insert_many(self, vectors: list[dict]) -> None:
        self._ndjson("insert", vectors)
```

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_vectorize_client.py -q`

- [ ] **Step 5: Add `FakeVectorize` to `tests/fakes.py`:**

```python
class FakeVectorize:
    def __init__(self):
        self.vectors: dict[str, dict] = {}   # id -> {"values","metadata"}
        self._forced: dict[str, float] = {}   # id -> score for next query
    def set_score(self, id: str, score: float):
        self._forced[id] = score
    def query(self, values, top_k=1):
        if self._forced:
            best = max(self._forced.items(), key=lambda kv: kv[1])
            return [{"id": best[0], "score": best[1], "metadata": self.vectors.get(best[0], {}).get("metadata", {})}]
        return []
    def upsert(self, id, values, metadata):
        self.vectors[id] = {"values": values, "metadata": metadata}
    def insert_many(self, vectors):
        for v in vectors:
            self.vectors[v["id"]] = {"values": v["values"], "metadata": v.get("metadata", {})}
```

- [ ] **Step 6: Commit**

```bash
git add src/sharedcache/vectorize_client.py tests/test_vectorize_client.py tests/fakes.py
git commit -m "feat: Vectorize REST client + in-memory fake"
```

---

## Task 5: D1 migration SQL

**Files:**
- Create: `worker/migrations/0001_init.sql`, `tests/test_d1_migration.py`

**Interfaces:**
- Produces the D1 schema (SQLite) for `assets`, `queries`, `api_keys` + the pending-count index, matching the column names/binding order used by `D1Client` (Task 3).

- [ ] **Step 1: Write the failing test** — `tests/test_d1_migration.py` (validates the DDL by executing it in stdlib sqlite3):

```python
import pathlib, sqlite3
SQL = (pathlib.Path(__file__).parent.parent / "worker" / "migrations" / "0001_init.sql").read_text()

def test_migration_creates_tables_and_columns():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SQL)
    cols = {t: {r[1] for r in conn.execute(f"PRAGMA table_info({t})")} for t in ("assets", "queries", "api_keys")}
    assert {"id","prompt","source","source_id","thumb_url","medium_url","url","model_used",
            "content_hash","width","height","mime","source_url","locally_cached","created_at"} <= cols["assets"]
    assert {"normalized_prompt","original_prompt","count","status","last_asset_id",
            "last_similarity","first_seen","last_seen"} <= cols["queries"]
    assert {"key_hash","created_at"} <= cols["api_keys"]
    # index present
    idx = {r[1] for r in conn.execute("PRAGMA index_list(queries)")}
    assert any("pending_count" in name for name in idx)
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_d1_migration.py -v`

- [ ] **Step 3: Create `worker/migrations/0001_init.sql`** with the exact DDL from spec §4.2 (assets, queries, api_keys, `idx_queries_pending_count`). Use `INTEGER` for `locally_cached`/`count`, `TEXT` timestamps with `DEFAULT (datetime('now'))`.

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_d1_migration.py -q`

- [ ] **Step 5: Commit**

```bash
git add worker/migrations/0001_init.sql tests/test_d1_migration.py
git commit -m "feat: D1 schema migration (assets, queries, api_keys)"
```

---

## Task 6: Backfill worker — generate + rehost passes

**Files:**
- Create: `src/sharedcache/backfill.py`, `tests/test_backfill.py`
- Test: `tests/test_backfill.py`

**Interfaces:**
- Consumes: `D1Client`/`FakeD1` (Task 3), `VectorizeClient`/`FakeVectorize` (Task 4), `ClipEmbedder` (Task 2), `Generator` (existing), `Storage`/`InMemoryStorage` (existing), `processor.derive_sizes` + `dimensions` (existing), `similarity_floor` (Task 1), `normalize_prompt`.
- Produces: `normalize_prompt(s) -> str`; `BackfillWorker(d1, vectorize, clip, generator, storage, *, floor_tolerance=0.15, floor_sim_max=0.35, floor_sim_min=0.18, batch_size=5, max_spend_usd=5.0, price_usd=0.04, model="shared-cache-gmicloud-gpt-image-1")` with `async generate_pass() -> int`, `async rehost_pass() -> int`, `async tick() -> dict`.

- [ ] **Step 1: Write the failing tests** — `tests/test_backfill.py`:

```python
import io, pytest
from PIL import Image
from sharedcache.backfill import BackfillWorker, normalize_prompt
from sharedcache.d1_client import QueryRow
from sharedcache.models import AssetRecord
from sharedcache.storage import InMemoryStorage
from sharedcache.generator import StubGenerator
from tests.fakes import FakeD1, FakeVectorize

class FakeClip:
    def text_embed(self, text): return [float(len(text) % 7)] * 8
    def image_embed(self, b): return [0.5] * 8

def _jpeg():
    out = io.BytesIO(); Image.new("RGB", (40, 20), "blue").save(out, format="JPEG"); return out.getvalue()

def _worker(d1, vec, **kw):
    storage = InMemoryStorage()
    return BackfillWorker(d1, vec, FakeClip(), StubGenerator(storage), storage,
                          floor_sim_max=0.35, floor_sim_min=0.18, **kw)

def test_normalize_prompt():
    assert normalize_prompt("  A  Red  Fox ") == "a red fox"

@pytest.mark.asyncio
async def test_generate_pass_builds_pending_and_upserts(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow("popular", "popular", 9), QueryRow("rare", "rare", 1)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0, price_usd=0.04)
    built = await w.generate_pass()
    assert built == 2
    assert d1.pending == []                       # both marked built
    assert len(vec.vectors) == 2                   # generated image vectors upserted
    assert len(d1.inserted) == 2                   # asset rows inserted
    # highest-count first
    assert d1.built[0][0] == "popular"

@pytest.mark.asyncio
async def test_generate_pass_rechecks_and_skips(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    vec.upsert("existing", [0.1] * 8, {"source": "pd12m"})
    vec.set_score("existing", 0.40)               # >= floor(0.15 tolerance -> ~0.32)
    d1.pending = [QueryRow("a cat", "a cat", 3)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=100.0)
    built = await w.generate_pass()
    assert built == 0                              # re-check found a match; no generation
    assert d1.inserted == []
    assert d1.built == [("a cat", "existing")]

@pytest.mark.asyncio
async def test_generate_pass_spend_cap(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.pending = [QueryRow(f"p{i}", f"p{i}", 1) for i in range(5)]
    w = _worker(d1, vec, batch_size=5, max_spend_usd=0.04, price_usd=0.04)
    built = await w.generate_pass()
    assert built == 1 and len(d1.pending) == 4     # cap after one build

@pytest.mark.asyncio
async def test_rehost_pass_downloads_and_updates(monkeypatch):
    import httpx
    d1, vec = FakeD1(), FakeVectorize()
    rec = AssetRecord(id="pd1", prompt="p", url="https://ext/x.jpg", thumb_url=None, medium_url=None,
                      model_used="clip-vit-l-14", source="pd12m", source_id="7", content_hash="pd12m-7",
                      width=40, height=20, mime="image/jpeg", manifest_url=None, created_at="",
                      source_url="https://ext/x.jpg", locally_cached=False)
    d1.rehost = [rec]
    jpg = _jpeg()
    class FakeResp:
        status_code = 200; content = jpg
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, **kw): return FakeResp()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: FakeClient())
    w = _worker(d1, vec, batch_size=5)
    done = await w.rehost_pass()
    assert done == 1 and d1.rehost == []
    aid, kw = d1.url_updates[0]
    assert aid == "pd1" and kw["locally_cached"] is True and kw["url"].endswith("image.webp")
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_backfill.py -v`

- [ ] **Step 3: Implement `src/sharedcache/backfill.py`:**

```python
import sys
import uuid
from sharedcache.floor import similarity_floor
from sharedcache.models import AssetRecord
from sharedcache.processor import derive_sizes, dimensions

def normalize_prompt(s: str) -> str:
    return " ".join(s.strip().lower().split())

class BackfillWorker:
    def __init__(self, d1, vectorize, clip, generator, storage, *, floor_tolerance: float = 0.15,
                 floor_sim_max: float = 0.35, floor_sim_min: float = 0.18, batch_size: int = 5,
                 max_spend_usd: float = 5.0, price_usd: float = 0.04,
                 model: str = "shared-cache-gmicloud-gpt-image-1"):
        self._d1 = d1
        self._vec = vectorize
        self._clip = clip
        self._gen = generator
        self._storage = storage
        self._floor = similarity_floor(floor_tolerance, sim_max=floor_sim_max, sim_min=floor_sim_min)
        self._batch = batch_size
        self._max_spend = max_spend_usd
        self._price = price_usd
        self._model = model

    async def generate_pass(self) -> int:
        built = 0
        spent = 0.0
        for q in self._d1.pending_queries(self._batch):
            match = self._vec.query(self._clip.text_embed(q.original_prompt), top_k=1)
            if match and match[0]["score"] >= self._floor:
                self._d1.mark_query_built(q.normalized_prompt, match[0]["id"])
                built += 1
                continue
            if spent + self._price > self._max_spend:
                break
            gen = await self._gen.generate(q.original_prompt, model=self._model, size="1024x1024")
            original = self._storage.get(gen.storage_key)
            image_vec = self._clip.image_embed(original)
            sizes = derive_sizes(original)
            w, h = dimensions(sizes["large"])
            asset_id = str(uuid.uuid4())
            url = self._storage.put(f"assets/{asset_id}/image.webp", sizes["large"], "image/webp")
            med = self._storage.put(f"assets/{asset_id}/medium.webp", sizes["medium"], "image/webp")
            thumb = self._storage.put(f"assets/{asset_id}/thumb.webp", sizes["thumb"], "image/webp")
            rec = AssetRecord(id=asset_id, prompt=q.original_prompt, url=url, thumb_url=thumb,
                              medium_url=med, model_used=gen.model_used, source="generated",
                              source_id=None, content_hash=gen.content_hash, width=w, height=h,
                              mime="image/webp", manifest_url=None, created_at="", locally_cached=True)
            self._vec.upsert(asset_id, image_vec, {"source": "generated"})
            self._d1.insert_asset(rec)
            self._d1.mark_query_built(q.normalized_prompt, asset_id)
            spent += self._price
            built += 1
        return built

    async def rehost_pass(self) -> int:
        import httpx
        done = 0
        for rec in self._d1.assets_needing_rehost(self._batch):
            try:
                src = rec.source_url or rec.url
                async with httpx.AsyncClient() as c:
                    resp = await c.get(src, follow_redirects=True, timeout=20.0)
                    if resp.status_code != 200:
                        raise RuntimeError(f"download {resp.status_code}")
                    orig = resp.content
                sizes = derive_sizes(orig)
                w, h = dimensions(sizes["large"])
                url = self._storage.put(f"assets/{rec.id}/image.webp", sizes["large"], "image/webp")
                med = self._storage.put(f"assets/{rec.id}/medium.webp", sizes["medium"], "image/webp")
                thumb = self._storage.put(f"assets/{rec.id}/thumb.webp", sizes["thumb"], "image/webp")
                self._d1.update_asset_urls(rec.id, url=url, medium_url=med, thumb_url=thumb,
                                           width=w, height=h, mime="image/webp", locally_cached=True)
                done += 1
            except Exception as e:
                print(f"rehost failed for {rec.id}: {e}", file=sys.stderr)
        return done

    async def tick(self) -> dict:
        return {"generated": await self.generate_pass(), "rehosted": await self.rehost_pass()}
```

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_backfill.py -q`

- [ ] **Step 5: Run the full suite — PASS.** `uv run pytest -q`

- [ ] **Step 6: Commit**

```bash
git add src/sharedcache/backfill.py tests/test_backfill.py
git commit -m "feat: backfill worker generate+rehost passes (demand-ranked, re-check, spend cap)"
```

---

## Task 7: Backfill CLI entry + loop

**Files:**
- Create: `src/sharedcache/__main__` behavior via `backfill.py` `main()` + `if __name__` guard
- Modify: `src/sharedcache/backfill.py` (add `run` + `main`)
- Test: `tests/test_backfill.py` (add a loop/once test)

**Interfaces:**
- Consumes: `Settings` (Task 1), the clients/generator/storage constructors.
- Produces: `async BackfillWorker.run(interval_seconds, *, once=False)`; `build_worker_from_settings(settings) -> BackfillWorker`; `main()` (parses `--once`, runs the loop).

- [ ] **Step 1: Write the failing test** — append to `tests/test_backfill.py`:

```python
@pytest.mark.asyncio
async def test_run_once_calls_tick_once():
    d1, vec = FakeD1(), FakeVectorize()
    w = _worker(d1, vec)
    calls = {"n": 0}
    async def fake_tick():
        calls["n"] += 1; return {"generated": 0, "rehosted": 0}
    w.tick = fake_tick
    await w.run(interval_seconds=0, once=True)
    assert calls["n"] == 1
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_backfill.py::test_run_once_calls_tick_once -v`

- [ ] **Step 3: Add `run` to `BackfillWorker` and module `main`** in `src/sharedcache/backfill.py`:

```python
    async def run(self, interval_seconds: int, *, once: bool = False) -> None:
        import asyncio
        while True:
            try:
                result = await self.tick()
                print(f"backfill tick: {result}")
            except Exception as e:
                print(f"backfill tick failed: {e}", file=sys.stderr)
            if once:
                return
            await asyncio.sleep(interval_seconds)


def build_worker_from_settings(s) -> "BackfillWorker":
    from sharedcache.clip import ClipEmbedder
    from sharedcache.d1_client import D1Client
    from sharedcache.vectorize_client import VectorizeClient
    from sharedcache.generator import GenblazeGenerator, StubGenerator
    from sharedcache.storage import GenblazeS3Storage, InMemoryStorage
    storage = (GenblazeS3Storage(s.b2_bucket, s.b2_key_id, s.b2_app_key, s.b2_region,
                                 public_url_base=s.b2_public_url_base)
               if s.b2_bucket and s.b2_key_id else InMemoryStorage())
    generator = (GenblazeGenerator(storage, openai_api_key=s.openai_api_key,
                                   gemini_api_key=s.gemini_api_key, gmicloud_api_key=s.gmicloud_api_key)
                 if (s.gmicloud_api_key or s.openai_api_key or s.gemini_api_key) and s.b2_bucket
                 else StubGenerator(storage))
    clip = ClipEmbedder(s.clip_text_embed_url, s.clip_image_embed_url, token=s.clip_embed_token)
    d1 = D1Client(s.cf_account_id, s.d1_database_id, s.cf_api_token)
    vec = VectorizeClient(s.cf_account_id, s.vectorize_index_name, s.cf_api_token)
    return BackfillWorker(d1, vec, clip, generator, storage,
                          floor_sim_max=s.floor_sim_max, floor_sim_min=s.floor_sim_min,
                          batch_size=s.worker_batch_size, max_spend_usd=s.worker_max_spend_usd,
                          price_usd=s.image_price_usd)


def main() -> None:
    import argparse, asyncio
    from sharedcache.config import Settings
    parser = argparse.ArgumentParser(description="SharedCache backfill worker")
    parser.add_argument("--once", action="store_true", help="run a single tick and exit")
    args = parser.parse_args()
    s = Settings()
    worker = build_worker_from_settings(s)
    asyncio.run(worker.run(s.worker_interval_seconds, once=args.once))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_backfill.py -q`

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/backfill.py tests/test_backfill.py
git commit -m "feat: backfill CLI entry (--once / loop) + settings wiring"
```

---

## Task 8: Rewrite PD12M seeder for Vectorize + D1

**Files:**
- Rewrite: `scripts/seed_pd12m.py`
- Test: `tests/test_seed_pd12m.py`

**Interfaces:**
- Consumes: `FakeD1`/`FakeVectorize` interfaces (`insert_asset`, `insert_many`).
- Produces: `seed_rows(rows, d1, vectorize, *, source="pd12m") -> int` where each row is `{"id","prompt","url","width","height","mime","embedding":[768 floats]}`; inserts a D1 asset (`locally_cached=False`, `url=source_url=row url`) and a Vectorize vector for each; returns count.

- [ ] **Step 1: Write the failing test** — `tests/test_seed_pd12m.py`:

```python
import importlib.util, pathlib
from sharedcache.models import AssetRecord
from tests.fakes import FakeD1, FakeVectorize

_spec = importlib.util.spec_from_file_location(
    "seed_pd12m", pathlib.Path(__file__).parent.parent / "scripts" / "seed_pd12m.py")
seed_pd12m = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(seed_pd12m)

def test_seed_rows_inserts_d1_and_vectorize():
    d1, vec = FakeD1(), FakeVectorize()
    rows = [{"id": "7", "prompt": "a fox", "url": "https://ext/fox.jpg",
             "width": 100, "height": 80, "mime": "image/jpeg", "embedding": [0.1] * 768}]
    n = seed_pd12m.seed_rows(rows, d1, vec)
    assert n == 1
    rec = d1.inserted[0]
    assert isinstance(rec, AssetRecord) and rec.source == "pd12m" and rec.source_id == "7"
    assert rec.locally_cached is False and rec.url == "https://ext/fox.jpg" and rec.source_url == "https://ext/fox.jpg"
    assert list(vec.vectors)[0] == rec.id and vec.vectors[rec.id]["metadata"] == {"source": "pd12m"}
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_seed_pd12m.py -v`

- [ ] **Step 3: Rewrite `scripts/seed_pd12m.py`** so its importable core is `seed_rows` (pure, testable) plus a `main()` that fetches PD12M rows+embeddings from the HF dataset and calls it. Core:

```python
import uuid
from sharedcache.models import AssetRecord

def seed_rows(rows, d1, vectorize, *, source="pd12m") -> int:
    n = 0
    batch = []
    for row in rows:
        asset_id = str(uuid.uuid4())
        rec = AssetRecord(
            id=asset_id, prompt=row["prompt"], url=row["url"], thumb_url=None, medium_url=None,
            model_used="clip-vit-l-14", source=source, source_id=str(row.get("id", n)),
            content_hash=f"{source}-{row.get('id', n)}", width=int(row.get("width", 0)),
            height=int(row.get("height", 0)), mime=row.get("mime", "image/jpeg"),
            manifest_url=None, created_at="", source_url=row["url"], locally_cached=False)
        d1.insert_asset(rec)
        batch.append({"id": asset_id, "values": list(row["embedding"]), "metadata": {"source": source}})
        n += 1
    if batch:
        vectorize.insert_many(batch)
    return n
```

The `main()` builds `D1Client`/`VectorizeClient` from `Settings`, pulls PD12M rows (caption/url/width/height) and precomputed embeddings from the HF dataset server, and calls `seed_rows`. Keep the HF fetch out of the tested core.

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_seed_pd12m.py -q`

- [ ] **Step 5: Run full suite — PASS.** `uv run pytest -q`

- [ ] **Step 6: Commit**

```bash
git add scripts/seed_pd12m.py tests/test_seed_pd12m.py
git commit -m "feat: PD12M seeder bulk-inserts D1 rows + Vectorize vectors"
```

---

## Task 9: Container + env + runbook

**Files:**
- Create: `Dockerfile`
- Modify: `.env.example`, `README.md` (backfill section)
- Test: none (packaging/docs) — verify the image builds if Docker is available; otherwise lint the Dockerfile by inspection.

- [ ] **Step 1: Create `Dockerfile`** (slim Python, installs the package, runs the backfill):

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
COPY src ./src
COPY scripts ./scripts
RUN uv sync --frozen --no-dev
ENTRYPOINT ["uv", "run", "python", "-m", "sharedcache.backfill"]
```

- [ ] **Step 2: Add the new env vars to `.env.example`** with comments:

```
# --- Cloudflare (backfill worker; request path lives in the Worker) ---
CF_ACCOUNT_ID=
CF_API_TOKEN=
D1_DATABASE_ID=
VECTORIZE_INDEX_NAME=sharedcache-clip
# --- CLIP embedding endpoints (swappable; HF Inference by default) ---
CLIP_TEXT_EMBED_URL=
CLIP_IMAGE_EMBED_URL=
CLIP_EMBED_TOKEN=
# --- Similarity floor (CLIP cross-modal scale; tune against the seeded pool) ---
FLOOR_SIM_MAX=0.35
FLOOR_SIM_MIN=0.18
```

- [ ] **Step 3: Add a "Backfill worker" section to `README.md`** documenting: apply D1 migration (`wrangler d1 migrations apply`), create the Vectorize index (`wrangler vectorize create sharedcache-clip --dimensions=768 --metric=cosine`), seed (`uv run python scripts/seed_pd12m.py`), and run the backfill (`uv run python -m sharedcache.backfill --once` locally or the container in a GMI Hermes agentbox). Note the CLIP endpoint env is required for generation embeds.

- [ ] **Step 4: If Docker is available, verify the image builds:** `docker build -t sharedcache-backfill .` (expected: builds; if Docker absent, skip and note it).

- [ ] **Step 5: Run the full suite once more — PASS.** `uv run pytest -q`

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .env.example README.md
git commit -m "chore: backfill Dockerfile, env vars, and runbook"
```

---

## Self-Review Notes (author checklist — done)

- **Spec coverage:** §3 embeddings → Tasks 1 (floor), 2 (CLIP); §4.1 Vectorize → Task 4; §4.2 D1 schema → Task 5, client → Task 3; §6 backfill (generate/rehost/rank/re-check/spend cap) → Tasks 6–7; §7 seed → Task 8; §9 env/Docker → Tasks 1, 9. The Worker (§5) is Plan 2.
- **Type consistency:** `AssetRecord` fields match the branch's current dataclass (`model_used`/`source`/`source_id`/`medium_url`, `locally_cached`); `D1Client`/`FakeD1` expose the same five methods the backfill calls; `VectorizeClient`/`FakeVectorize` expose `query`/`upsert`/`insert_many`; `ClipEmbedder.text_embed`/`image_embed` used consistently in Tasks 2, 6; `similarity_floor(sim_max, sim_min)` signature consistent Tasks 1, 6.
- **Placeholder scan:** every code step carries full code; env values (`CF_*`, CLIP URLs) are legitimately operator-set blanks, documented.
- **Fakes-first testing:** no test performs real network I/O; D1/Vectorize/CLIP/httpx all mocked or faked; `derive_sizes`/Genblaze/B2 keep their existing offline tests.
- **Ordering:** config/floor → embedder → clients → migration → backfill → CLI → seed → packaging, so each task's suite stays green.
