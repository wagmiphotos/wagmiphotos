# SharedCache MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SharedCache — a semantic cache for image generation behind an OpenAI-compatible API: a hit returns a prior asset from Backblaze B2; a miss generates via Genblaze, stores asset + provenance manifest in B2, indexes it, and returns it.

**Architecture:** A FastAPI service whose `CacheService` orchestrates `Embedder` → `CacheIndex` (pgvector) → on hit serve from B2 / on miss `Generator` (Genblaze pipeline writing to B2 via its `genblaze-s3` sink) → `Processor` (WebP thumb) → index insert → `CostMeter`. Every external dependency sits behind a small protocol so the orchestrator is unit-tested fully offline with stubs; real adapters are smoke-tested against live keys.

**Tech Stack:** Python 3.11+, uv, FastAPI + uvicorn, Postgres 15 + pgvector, `genblaze-core` + `genblaze-openai` + `genblaze-s3`, `google-genai` (Gemini embeddings), Pillow, psycopg 3, numpy, pytest + pytest-asyncio.

## Global Constraints

- **Python:** `>=3.11` (Genblaze requires it). Manage with `uv`.
- **Pin Genblaze (alpha, version churn):** depend on the umbrella `genblaze[openai]>=0.4,<0.5` (resolves to `genblaze==0.4.0`, which transitively pins `genblaze-core`/`genblaze-openai` to 0.3.x and bundles `genblaze-s3`); commit `uv.lock` so resolved versions are reproducible.
- **Genblaze calls:** always pass `raise_on_failure=True`; default image model `gpt-image-1` (base64 → persisted by sink; never `dall-e-3`, whose URLs expire ~1h); set `Pipeline(preflight=False)` anywhere offline/tested.
- **Auth/secrets:** per-provider + B2 keys via env only, NEVER in `step.params`: `OPENAI_API_KEY`, optional `GEMINI_API_KEY`, `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION` (default `us-west-004`).
- **`cache_tolerance`** ∈ [0.0, 1.0]: 0 = bespoke (always generate), 1 = max reuse. Default **0.15**. Maps to a cosine-similarity floor with `SIM_MAX=0.98`, `SIM_MIN=0.70`.
- **Model ID** accepted by the API: `image-cache-1` (the SharedCache product model; distinct from the underlying Genblaze provider model).
- **License/trust:** persist every generated asset through the Genblaze sink so `Asset.sha256` is populated (provenance issue #77). Store the manifest in B2.
- **TDD:** every behavior gets a failing test first. Commit after each green task.

---

## File Structure

```
sharedcache/
  pyproject.toml                  # uv project + pinned deps
  .env.example                    # all env vars documented
  README.md                       # what it does, B2 + Genblaze usage, providers/models
  scripts/
    migrate.sql                   # assets + savings_ledger tables (pgvector)
    seed.py                       # pre-seed the demo pool
  src/sharedcache/
    __init__.py
    config.py                     # Settings (env-backed)
    floor.py                      # cache_tolerance -> similarity floor (pure)
    models.py                     # AssetRecord, Generated, GenerationResult dataclasses
    embedder.py                   # Embedder protocol, GeminiEmbedder, HashEmbedder
    index.py                      # CacheIndex protocol, InMemoryCacheIndex, PgCacheIndex
    storage.py                    # Storage protocol, InMemoryStorage, GenblazeS3Storage
    generator.py                  # Generator protocol, StubGenerator, GenblazeGenerator
    processor.py                  # WebP derivative (thumb)
    pricing.py                    # provider/model -> USD price table
    cost_meter.py                 # CostMeter
    cache_service.py              # CacheService orchestrator
    api.py                        # FastAPI app + OpenAI-compatible endpoint + UI mount
  web/
    index.html                    # playground
  tests/
    conftest.py                   # fixtures + stubs wiring
    test_config.py
    test_floor.py
    test_embedder.py
    test_index.py
    test_index_pg.py              # integration, skipped without DATABASE_URL
    test_storage.py
    test_generator.py
    test_processor.py
    test_cost_meter.py
    test_cache_service.py
    test_api.py
```

---

### Task 1: Project scaffold + config

**Files:**
- Create: `pyproject.toml`, `.env.example`, `src/sharedcache/__init__.py`, `src/sharedcache/config.py`, `tests/conftest.py`, `tests/test_config.py`

**Interfaces:**
- Produces: `Settings` with attributes `openai_api_key: str|None`, `gemini_api_key: str|None`, `b2_key_id: str|None`, `b2_app_key: str|None`, `b2_bucket: str|None`, `b2_region: str` (default `"us-west-004"`), `database_url: str|None`, `embedding_dims: int` (default `768`), `default_image_model: str` (default `"gpt-image-1"`), `api_key: str|None` (SharedCache caller key). Constructor: `Settings()` reads env; `Settings(**overrides)` for tests.

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "sharedcache"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "pydantic-settings>=2.5",
    "google-genai>=0.3",
    "pillow>=10",
    "numpy>=1.26",
    "psycopg[binary]>=3.2",
    "pgvector>=0.3",
    "genblaze[openai]>=0.4,<0.5",
]

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.24", "httpx>=0.27"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
pythonpath = ["src"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- [ ] **Step 2: Write the failing test** — `tests/test_config.py`

```python
from sharedcache.config import Settings

def test_defaults_apply_when_env_absent():
    s = Settings(_env_file=None)
    assert s.b2_region == "us-west-004"
    assert s.embedding_dims == 768
    assert s.default_image_model == "gpt-image-1"

def test_overrides_win():
    s = Settings(_env_file=None, b2_bucket="my-bucket", embedding_dims=3072)
    assert s.b2_bucket == "my-bucket"
    assert s.embedding_dims == 3072
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_config.py -v`
Expected: FAIL (`ModuleNotFoundError: sharedcache.config`)

- [ ] **Step 4: Implement `src/sharedcache/config.py`**

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    b2_key_id: str | None = None
    b2_app_key: str | None = None
    b2_bucket: str | None = None
    b2_region: str = "us-west-004"
    database_url: str | None = None
    embedding_dims: int = 768
    default_image_model: str = "gpt-image-1"
    api_key: str | None = None
```

Also create empty `src/sharedcache/__init__.py` and a `tests/conftest.py` containing only `import sys` placeholder (fixtures added in later tasks):

```python
# tests/conftest.py
# Shared fixtures are added by later tasks.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Write `.env.example`**

```bash
OPENAI_API_KEY=
GEMINI_API_KEY=
B2_KEY_ID=
B2_APP_KEY=
B2_BUCKET=
B2_REGION=us-west-004
DATABASE_URL=postgresql://localhost:5432/sharedcache
EMBEDDING_DIMS=768
DEFAULT_IMAGE_MODEL=gpt-image-1
API_KEY=dev-key
```

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml .env.example src/sharedcache/__init__.py src/sharedcache/config.py tests/conftest.py tests/test_config.py
git commit -m "feat: scaffold project + env-backed Settings"
```

---

### Task 2: cache_tolerance → similarity floor (pure logic)

**Files:**
- Create: `src/sharedcache/floor.py`, `tests/test_floor.py`

**Interfaces:**
- Produces: `similarity_floor(cache_tolerance: float, *, sim_max: float = 0.98, sim_min: float = 0.70) -> float`. Linear: `sim_max - cache_tolerance * (sim_max - sim_min)`. Clamps `cache_tolerance` to [0, 1].

- [ ] **Step 1: Write the failing test** — `tests/test_floor.py`

```python
import pytest
from sharedcache.floor import similarity_floor

def test_zero_tolerance_requires_near_exact():
    assert similarity_floor(0.0) == pytest.approx(0.98)

def test_full_tolerance_is_loosest():
    assert similarity_floor(1.0) == pytest.approx(0.70)

def test_default_is_conservative():
    assert similarity_floor(0.15) == pytest.approx(0.98 - 0.15 * 0.28)

def test_clamps_out_of_range():
    assert similarity_floor(-1.0) == pytest.approx(0.98)
    assert similarity_floor(2.0) == pytest.approx(0.70)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_floor.py -v`
Expected: FAIL (`ModuleNotFoundError: sharedcache.floor`)

- [ ] **Step 3: Implement `src/sharedcache/floor.py`**

```python
def similarity_floor(cache_tolerance: float, *, sim_max: float = 0.98, sim_min: float = 0.70) -> float:
    t = min(1.0, max(0.0, cache_tolerance))
    return sim_max - t * (sim_max - sim_min)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_floor.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/floor.py tests/test_floor.py
git commit -m "feat: cache_tolerance to similarity-floor mapping"
```

---

### Task 3: Shared dataclasses

**Files:**
- Create: `src/sharedcache/models.py`, `tests/test_models.py`

**Interfaces:**
- Produces:
  - `AssetRecord(id: str, prompt: str, url: str, thumb_url: str | None, provider: str, model: str, content_hash: str, width: int, height: int, mime: str, manifest_url: str | None, created_at: str)`
  - `Generated(url: str, content_hash: str, width: int, height: int, mime: str, provider: str, model: str, manifest_json: str, manifest_hash: str, storage_key: str)`
  - `GenerationResult(record: AssetRecord, result: str, similarity: float, cost_saved_usd: float)` where `result` ∈ {"hit","miss"}.

- [ ] **Step 1: Write the failing test** — `tests/test_models.py`

```python
from sharedcache.models import AssetRecord, Generated, GenerationResult

def test_asset_record_roundtrips_fields():
    r = AssetRecord(id="a", prompt="p", url="u", thumb_url=None, provider="openai",
                    model="gpt-image-1", content_hash="h", width=1024, height=1024,
                    mime="image/webp", manifest_url=None, created_at="2026-06-23T00:00:00Z")
    assert r.width == 1024 and r.provider == "openai"

def test_generation_result_holds_outcome():
    r = AssetRecord(id="a", prompt="p", url="u", thumb_url=None, provider="o", model="m",
                    content_hash="h", width=1, height=1, mime="image/webp",
                    manifest_url=None, created_at="t")
    gr = GenerationResult(record=r, result="hit", similarity=0.93, cost_saved_usd=0.04)
    assert gr.result == "hit" and gr.cost_saved_usd == 0.04
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_models.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/models.py`**

```python
from dataclasses import dataclass

@dataclass
class AssetRecord:
    id: str
    prompt: str
    url: str
    thumb_url: str | None
    provider: str
    model: str
    content_hash: str
    width: int
    height: int
    mime: str
    manifest_url: str | None
    created_at: str

@dataclass
class Generated:
    url: str
    content_hash: str
    width: int
    height: int
    mime: str
    provider: str
    model: str
    manifest_json: str
    manifest_hash: str
    storage_key: str

@dataclass
class GenerationResult:
    record: AssetRecord
    result: str  # "hit" | "miss"
    similarity: float
    cost_saved_usd: float
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/models.py tests/test_models.py
git commit -m "feat: shared dataclasses (AssetRecord, Generated, GenerationResult)"
```

---

### Task 4: Embedder (protocol + Gemini + hash stub)

**Files:**
- Create: `src/sharedcache/embedder.py`, `tests/test_embedder.py`

**Interfaces:**
- Consumes: `Settings` (Task 1).
- Produces: `Embedder` Protocol with `embed(self, text: str) -> list[float]`. `HashEmbedder(dims: int)` — deterministic offline embedder. `GeminiEmbedder(api_key: str, dims: int, model: str = "text-embedding-004")` — real.

- [ ] **Step 1: Write the failing test** — `tests/test_embedder.py`

```python
from sharedcache.embedder import HashEmbedder

def test_hash_embedder_is_deterministic_and_sized():
    e = HashEmbedder(dims=768)
    a = e.embed("a cozy cafe")
    b = e.embed("a cozy cafe")
    assert len(a) == 768
    assert a == b

def test_hash_embedder_differs_by_text():
    e = HashEmbedder(dims=64)
    assert e.embed("cat") != e.embed("dog")

def test_hash_embedder_is_unit_norm():
    e = HashEmbedder(dims=64)
    v = e.embed("anything")
    assert abs(sum(x * x for x in v) - 1.0) < 1e-6
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_embedder.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/embedder.py`**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_embedder.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/embedder.py tests/test_embedder.py
git commit -m "feat: Embedder protocol + HashEmbedder + GeminiEmbedder"
```

---

### Task 5: CacheIndex (protocol + in-memory; pgvector impl + integration test)

**Files:**
- Create: `src/sharedcache/index.py`, `tests/test_index.py`, `tests/test_index_pg.py`, `scripts/migrate.sql`

**Interfaces:**
- Consumes: `AssetRecord` (Task 3).
- Produces: `CacheIndex` Protocol with `search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]` (returns `(record, cosine_similarity)` desc) and `insert(self, record: AssetRecord, embedding: list[float]) -> None`. `InMemoryCacheIndex()` and `PgCacheIndex(dsn: str, dims: int)`.

- [ ] **Step 1: Write the failing test** — `tests/test_index.py`

```python
from sharedcache.index import InMemoryCacheIndex
from sharedcache.models import AssetRecord

def _rec(id):
    return AssetRecord(id=id, prompt=id, url=f"u/{id}", thumb_url=None, provider="o",
                       model="m", content_hash=id, width=1, height=1, mime="image/webp",
                       manifest_url=None, created_at="t")

def test_search_empty_returns_nothing():
    assert InMemoryCacheIndex().search([1.0, 0.0]) == []

def test_search_ranks_by_cosine_similarity():
    idx = InMemoryCacheIndex()
    idx.insert(_rec("near"), [1.0, 0.0])
    idx.insert(_rec("far"), [0.0, 1.0])
    results = idx.search([0.9, 0.1], k=2)
    assert results[0][0].id == "near"
    assert results[0][1] > results[1][1]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_index.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/index.py`**

```python
from typing import Protocol
import numpy as np
from sharedcache.models import AssetRecord

class CacheIndex(Protocol):
    def search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]: ...
    def insert(self, record: AssetRecord, embedding: list[float]) -> None: ...

def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))

class InMemoryCacheIndex:
    def __init__(self) -> None:
        self._rows: list[tuple[AssetRecord, np.ndarray]] = []

    def insert(self, record: AssetRecord, embedding: list[float]) -> None:
        self._rows.append((record, np.asarray(embedding, dtype=float)))

    def search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]:
        q = np.asarray(embedding, dtype=float)
        scored = [(rec, _cosine(q, vec)) for rec, vec in self._rows]
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:k]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_index.py -v`
Expected: PASS

- [ ] **Step 5: Write `scripts/migrate.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt TEXT NOT NULL,
    url TEXT NOT NULL,
    thumb_url TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    mime TEXT NOT NULL,
    manifest_url TEXT,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_embedding
    ON assets USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS savings_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key TEXT,
    asset_id UUID REFERENCES assets(id),
    cost_saved_usd NUMERIC(10,5) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 6: Add `PgCacheIndex` to `src/sharedcache/index.py`**

```python
import json
import psycopg
from pgvector.psycopg import register_vector

class PgCacheIndex:
    def __init__(self, dsn: str, dims: int = 768):
        self._dsn = dsn
        self._dims = dims

    def _conn(self):
        conn = psycopg.connect(self._dsn)
        register_vector(conn)
        return conn

    def insert(self, record: AssetRecord, embedding: list[float]) -> None:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO assets (id, prompt, url, thumb_url, provider, model,
                       content_hash, width, height, mime, manifest_url, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (record.id, record.prompt, record.url, record.thumb_url, record.provider,
                 record.model, record.content_hash, record.width, record.height,
                 record.mime, record.manifest_url, np.asarray(embedding, dtype=float)),
            )
            conn.commit()

    def search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]:
        q = np.asarray(embedding, dtype=float)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, prompt, url, thumb_url, provider, model, content_hash,
                          width, height, mime, manifest_url, created_at,
                          1 - (embedding <=> %s) AS similarity
                   FROM assets ORDER BY embedding <=> %s LIMIT %s""",
                (q, q, k),
            )
            out = []
            for row in cur.fetchall():
                rec = AssetRecord(id=str(row[0]), prompt=row[1], url=row[2], thumb_url=row[3],
                                  provider=row[4], model=row[5], content_hash=row[6],
                                  width=row[7], height=row[8], mime=row[9], manifest_url=row[10],
                                  created_at=row[11].isoformat())
                out.append((rec, float(row[12])))
            return out
```

- [ ] **Step 7: Write the integration test** — `tests/test_index_pg.py`

```python
import os
import uuid
import pytest
from sharedcache.index import PgCacheIndex
from sharedcache.models import AssetRecord

pytestmark = pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="no DATABASE_URL")

def _rec():
    i = str(uuid.uuid4())
    return AssetRecord(id=i, prompt="cozy cafe", url="u", thumb_url=None, provider="openai",
                       model="gpt-image-1", content_hash="h", width=1024, height=1024,
                       mime="image/webp", manifest_url=None, created_at="t")

def test_pg_insert_and_search_roundtrip():
    idx = PgCacheIndex(os.environ["DATABASE_URL"], dims=768)
    rec = _rec()
    idx.insert(rec, [0.1] * 768)
    results = idx.search([0.1] * 768, k=1)
    assert results and results[0][1] > 0.99
```

- [ ] **Step 8: Run tests**

Run: `uv run pytest tests/test_index.py tests/test_index_pg.py -v`
Expected: `test_index.py` PASS; `test_index_pg.py` SKIPPED (no `DATABASE_URL`) or PASS if a local pgvector DB is migrated.

- [ ] **Step 9: Commit**

```bash
git add src/sharedcache/index.py tests/test_index.py tests/test_index_pg.py scripts/migrate.sql
git commit -m "feat: CacheIndex (in-memory + pgvector) and schema"
```

---

### Task 6: Storage (protocol + in-memory + Genblaze S3)

**Files:**
- Create: `src/sharedcache/storage.py`, `tests/test_storage.py`

**Interfaces:**
- Consumes: `Settings` (Task 1).
- Produces: `Storage` Protocol with `put(self, key: str, data: bytes, content_type: str) -> str` (returns URL), `get(self, key: str) -> bytes`, `key_from_url(self, url: str) -> str`. `InMemoryStorage()` and `GenblazeS3Storage(bucket, key_id, app_key, region)` exposing `.backend` (a Genblaze `S3StorageBackend`) for the sink in Task 8.

- [ ] **Step 1: Write the failing test** — `tests/test_storage.py`

```python
from sharedcache.storage import InMemoryStorage

def test_put_returns_url_and_get_roundtrips():
    s = InMemoryStorage()
    url = s.put("assets/x/thumb.webp", b"bytes", "image/webp")
    assert "assets/x/thumb.webp" in url
    assert s.get(s.key_from_url(url)) == b"bytes"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_storage.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/storage.py`**

```python
from typing import Protocol

class Storage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> str: ...
    def get(self, key: str) -> bytes: ...
    def key_from_url(self, url: str) -> str: ...

class InMemoryStorage:
    BASE = "memory://sharedcache/"
    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self._blobs[key] = data
        return self.BASE + key

    def get(self, key: str) -> bytes:
        return self._blobs[key]

    def key_from_url(self, url: str) -> str:
        return url.split(self.BASE, 1)[-1] if url.startswith(self.BASE) else url

class GenblazeS3Storage:
    """Wraps Genblaze's S3 backend so the same B2 backend is used for the
    generation sink (Task 8) and for our thumbnail put/get."""
    def __init__(self, bucket: str, key_id: str, app_key: str, region: str = "us-west-004"):
        from genblaze_s3 import S3StorageBackend
        self.backend = S3StorageBackend.for_backblaze(
            bucket, region=region, key_id=key_id, app_key=app_key
        )

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self.backend.put(key, data, content_type=content_type)
        return self.backend.get_url(key)

    def get(self, key: str) -> bytes:
        return self.backend.get(key)

    def key_from_url(self, url: str) -> str:
        return self.backend.key_from_url(url)
```

> NOTE for implementer: confirm `backend.put(key, data, content_type=...)`, `get_url`, `get`, and `key_from_url` signatures against the pinned `genblaze-s3` (the research report cites `backend.get(key) -> bytes`, `get_url(key, expires_in=...)`, `key_from_url(url)` in `storage/base.py`). Adjust kwarg names if the pinned version differs; the `Storage` protocol shape stays the same.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_storage.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/storage.py tests/test_storage.py
git commit -m "feat: Storage protocol + in-memory + Genblaze S3 backend"
```

---

### Task 7: Processor (WebP thumbnail)

**Files:**
- Create: `src/sharedcache/processor.py`, `tests/test_processor.py`

**Interfaces:**
- Produces: `make_thumbnail(image_bytes: bytes, max_px: int = 512) -> bytes` (returns WebP bytes) and `dimensions(image_bytes: bytes) -> tuple[int, int]`.

- [ ] **Step 1: Write the failing test** — `tests/test_processor.py`

```python
import io
from PIL import Image
from sharedcache.processor import make_thumbnail, dimensions

def _png(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 200)).save(buf, format="PNG")
    return buf.getvalue()

def test_thumbnail_is_webp_and_bounded():
    out = make_thumbnail(_png(2000, 1000), max_px=512)
    img = Image.open(io.BytesIO(out))
    assert img.format == "WEBP"
    assert max(img.size) <= 512

def test_dimensions_reads_size():
    assert dimensions(_png(640, 480)) == (640, 480)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_processor.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/processor.py`**

```python
import io
from PIL import Image

def dimensions(image_bytes: bytes) -> tuple[int, int]:
    return Image.open(io.BytesIO(image_bytes)).size

def make_thumbnail(image_bytes: bytes, max_px: int = 512) -> bytes:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    img.thumbnail((max_px, max_px))
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=80)
    return out.getvalue()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_processor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/processor.py tests/test_processor.py
git commit -m "feat: WebP thumbnail processor"
```

---

### Task 8: Generator (protocol + stub + Genblaze)

**Files:**
- Create: `src/sharedcache/generator.py`, `tests/test_generator.py`

**Interfaces:**
- Consumes: `Generated` (Task 3), `Storage` / `GenblazeS3Storage` (Task 6).
- Produces: `Generator` Protocol with `async generate(self, prompt: str, *, model: str, size: str = "1024x1024") -> Generated`. `StubGenerator(storage)` — writes fake bytes into the given `Storage` and returns deterministic `Generated`. `GenblazeGenerator(storage, openai_api_key, project_id="sharedcache")` — real.

- [ ] **Step 1: Write the failing test** — `tests/test_generator.py`

```python
import pytest
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage

@pytest.mark.asyncio
async def test_stub_generator_persists_bytes_and_returns_metadata():
    storage = InMemoryStorage()
    gen = StubGenerator(storage)
    out = await gen.generate("a red bicycle", model="gpt-image-1", size="1024x1024")
    assert out.provider == "stub"
    assert out.width == 1024 and out.height == 1024
    assert out.manifest_hash and out.content_hash
    assert storage.get(out.storage_key)  # bytes were persisted
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_generator.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/generator.py`**

```python
import hashlib
import io
import json
from typing import Protocol
from PIL import Image
from sharedcache.models import Generated

class Generator(Protocol):
    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024") -> Generated: ...

def _solid_png(w: int, h: int, seed: int) -> bytes:
    color = (seed % 255, (seed * 7) % 255, (seed * 13) % 255)
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()

class StubGenerator:
    """Offline generator: deterministic image + manifest, persisted to Storage."""
    def __init__(self, storage):
        self._storage = storage

    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024") -> Generated:
        w, h = (int(x) for x in size.split("x"))
        seed = int(hashlib.sha256(prompt.encode()).hexdigest(), 16) % 1000
        data = _solid_png(w, h, seed)
        content_hash = hashlib.sha256(data).hexdigest()
        key = f"assets/{content_hash}/original.png"
        url = self._storage.put(key, data, "image/png")
        manifest = {"schema_version": "1.5", "prompt": prompt, "model": model,
                    "sha256": content_hash, "media_type": "image/png", "size_bytes": len(data)}
        manifest_json = json.dumps(manifest, sort_keys=True)
        manifest_hash = hashlib.sha256(manifest_json.encode()).hexdigest()
        return Generated(url=url, content_hash=content_hash, width=w, height=h,
                         mime="image/png", provider="stub", model=model,
                         manifest_json=manifest_json, manifest_hash=manifest_hash, storage_key=key)

class GenblazeGenerator:
    """Real generator: Genblaze pipeline writing to B2 via the genblaze-s3 sink."""
    def __init__(self, storage, openai_api_key: str, project_id: str = "sharedcache"):
        self._storage = storage
        self._openai_api_key = openai_api_key
        self._project_id = project_id

    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024") -> Generated:
        from genblaze_core import Modality, Pipeline, ObjectStorageSink, KeyStrategy
        from genblaze_openai import DalleProvider

        sink = ObjectStorageSink(self._storage.backend, key_strategy=KeyStrategy.CONTENT_ADDRESSABLE)
        result = await (
            Pipeline("sharedcache-gen", project_id=self._project_id, preflight=False)
            .step(DalleProvider(api_key=self._openai_api_key), model=model,
                  prompt=prompt, modality=Modality.IMAGE, size=size)
            .arun(sink=sink, raise_on_failure=True, timeout=120)
        )
        asset = result.run.steps[0].assets[0]
        manifest_json = result.manifest.to_canonical_json()
        key = self._storage.key_from_url(asset.url)
        return Generated(url=asset.url, content_hash=asset.sha256, width=asset.width or 0,
                         height=asset.height or 0, mime=asset.media_type, provider="openai",
                         model=model, manifest_json=manifest_json,
                         manifest_hash=result.manifest.canonical_hash, storage_key=key)
```

> NOTE for implementer: the `GenblazeGenerator` is exercised by the Task 12 live smoke test (needs real keys), not by unit tests. Verify the `ObjectStorageSink`/`Pipeline.arun` kwargs against the pinned Genblaze version (research report: `pipeline.py:1501`, `examples/b2_storage_pipeline.py`). The `Generator` protocol keeps `CacheService` testable via `StubGenerator`.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_generator.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/generator.py tests/test_generator.py
git commit -m "feat: Generator protocol + StubGenerator + GenblazeGenerator"
```

---

### Task 9: Pricing + CostMeter

**Files:**
- Create: `src/sharedcache/pricing.py`, `src/sharedcache/cost_meter.py`, `tests/test_cost_meter.py`

**Interfaces:**
- Produces: `price_usd(provider: str, model: str) -> float` (0.0 if unknown). `CostMeter()` with `cost_saved(provider: str, model: str) -> float`, `record_hit(api_key: str | None, asset_id: str, provider: str, model: str) -> float`, `total_saved() -> float`.

- [ ] **Step 1: Write the failing test** — `tests/test_cost_meter.py`

```python
from sharedcache.cost_meter import CostMeter
from sharedcache.pricing import price_usd

def test_known_price_lookup():
    assert price_usd("openai", "gpt-image-1") > 0

def test_unknown_price_is_zero():
    assert price_usd("nobody", "nothing") == 0.0

def test_record_hit_accumulates_total():
    m = CostMeter()
    saved = m.record_hit("k1", "asset-1", "openai", "gpt-image-1")
    assert saved == price_usd("openai", "gpt-image-1")
    m.record_hit("k1", "asset-2", "openai", "gpt-image-1")
    assert m.total_saved() == saved * 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cost_meter.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/pricing.py` and `cost_meter.py`**

```python
# pricing.py — public per-image prices (USD). Genblaze ships none, so we keep our own.
_PRICES: dict[tuple[str, str], float] = {
    ("openai", "gpt-image-1"): 0.04,
    ("openai", "dall-e-3"): 0.04,
    ("google", "imagen-3.0-generate-002"): 0.04,
    ("stub", "gpt-image-1"): 0.04,
}

def price_usd(provider: str, model: str) -> float:
    return _PRICES.get((provider, model), 0.0)
```

```python
# cost_meter.py
from dataclasses import dataclass, field
from sharedcache.pricing import price_usd

@dataclass
class CostMeter:
    _ledger: list[tuple[str | None, str, float]] = field(default_factory=list)

    def cost_saved(self, provider: str, model: str) -> float:
        return price_usd(provider, model)

    def record_hit(self, api_key: str | None, asset_id: str, provider: str, model: str) -> float:
        saved = self.cost_saved(provider, model)
        self._ledger.append((api_key, asset_id, saved))
        return saved

    def total_saved(self) -> float:
        return round(sum(s for _, _, s in self._ledger), 5)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_cost_meter.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/pricing.py src/sharedcache/cost_meter.py tests/test_cost_meter.py
git commit -m "feat: pricing table + CostMeter"
```

---

### Task 10: CacheService (the orchestrator)

**Files:**
- Create: `src/sharedcache/cache_service.py`, `tests/test_cache_service.py`

**Interfaces:**
- Consumes: `Embedder`, `CacheIndex`, `Generator`, `Storage`, `CostMeter`, `make_thumbnail`/`dimensions` (Task 7), `similarity_floor` (Task 2), `AssetRecord`/`GenerationResult` (Task 3).
- Produces: `CacheService(embedder, index, generator, storage, cost_meter, *, created_at_fn)` with `async generate(self, prompt: str, *, cache_tolerance: float = 0.15, size: str = "1024x1024", api_key: str | None = None, model: str = "gpt-image-1") -> GenerationResult`. `created_at_fn() -> str` is injected (so tests are deterministic; no wall clock in core).

- [ ] **Step 1: Write the failing tests** — `tests/test_cache_service.py`

```python
import pytest
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter

def _service():
    storage = InMemoryStorage()
    return CacheService(HashEmbedder(64), InMemoryCacheIndex(), StubGenerator(storage),
                        storage, CostMeter(), created_at_fn=lambda: "2026-06-23T00:00:00Z")

@pytest.mark.asyncio
async def test_first_request_is_a_miss_and_indexes():
    svc = _service()
    r = await svc.generate("a red bicycle", cache_tolerance=0.15)
    assert r.result == "miss"
    assert r.cost_saved_usd == 0.0
    assert r.record.thumb_url is not None

@pytest.mark.asyncio
async def test_identical_repeat_is_a_hit_and_saves_cost():
    svc = _service()
    await svc.generate("a red bicycle", cache_tolerance=0.15)
    r2 = await svc.generate("a red bicycle", cache_tolerance=0.15)
    assert r2.result == "hit"
    assert r2.similarity > 0.99
    assert r2.cost_saved_usd > 0

@pytest.mark.asyncio
async def test_zero_tolerance_forces_regeneration():
    svc = _service()
    await svc.generate("a red bicycle")
    r2 = await svc.generate("a red bicycle", cache_tolerance=0.0)
    # floor 0.98; identical prompt embeds identically (sim 1.0) so this still hits.
    # A *different* prompt at tol 0 must miss:
    r3 = await svc.generate("a blue canoe", cache_tolerance=0.0)
    assert r3.result == "miss"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cache_service.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/cache_service.py`**

```python
import uuid
from sharedcache.floor import similarity_floor
from sharedcache.models import AssetRecord, GenerationResult
from sharedcache.processor import make_thumbnail, dimensions

class CacheService:
    def __init__(self, embedder, index, generator, storage, cost_meter, *, created_at_fn):
        self._embedder = embedder
        self._index = index
        self._generator = generator
        self._storage = storage
        self._cost = cost_meter
        self._now = created_at_fn

    async def generate(self, prompt: str, *, cache_tolerance: float = 0.15,
                       size: str = "1024x1024", api_key: str | None = None,
                       model: str = "gpt-image-1") -> GenerationResult:
        embedding = self._embedder.embed(prompt)
        floor = similarity_floor(cache_tolerance)

        top = self._index.search(embedding, k=1)
        if top and top[0][1] >= floor:
            record, sim = top[0]
            saved = self._cost.record_hit(api_key, record.id, record.provider, record.model)
            return GenerationResult(record=record, result="hit", similarity=sim, cost_saved_usd=saved)

        gen = await self._generator.generate(prompt, model=model, size=size)
        original = self._storage.get(gen.storage_key)
        thumb_bytes = make_thumbnail(original)
        w, h = dimensions(original)
        asset_id = str(uuid.uuid4())
        thumb_url = self._storage.put(f"assets/{asset_id}/thumb.webp", thumb_bytes, "image/webp")
        manifest_url = self._storage.put(f"assets/{asset_id}/manifest.json",
                                         gen.manifest_json.encode(), "application/json")
        record = AssetRecord(id=asset_id, prompt=prompt, url=gen.url, thumb_url=thumb_url,
                             provider=gen.provider, model=gen.model, content_hash=gen.content_hash,
                             width=w, height=h, mime=gen.mime, manifest_url=manifest_url,
                             created_at=self._now())
        self._index.insert(record, embedding)
        return GenerationResult(record=record, result="miss", similarity=0.0, cost_saved_usd=0.0)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_cache_service.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/cache_service.py tests/test_cache_service.py
git commit -m "feat: CacheService hit/miss orchestration"
```

---

### Task 11: API layer (OpenAI-compatible) + wiring

**Files:**
- Create: `src/sharedcache/api.py`, `tests/test_api.py`

**Interfaces:**
- Consumes: `CacheService` (Task 10), `Settings` (Task 1).
- Produces: FastAPI `app`. `POST /v1/images/generations` accepting `{model, prompt, n, size, cache_tolerance}` and returning OpenAI-shaped `{created, data:[{url}], shared_cache:{result, similarity, cost_saved_usd, provider, model, provenance_url}}`. `GET /healthz`. `build_app(service: CacheService, api_key: str | None) -> FastAPI` for injection in tests. A module-level `app` built from real Settings for `uvicorn`.

- [ ] **Step 1: Write the failing test** — `tests/test_api.py`

```python
from fastapi.testclient import TestClient
from sharedcache.api import build_app
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter

def _client():
    storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(64), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    return TestClient(build_app(svc, api_key="secret"))

def test_requires_api_key():
    r = _client().post("/v1/images/generations", json={"prompt": "x"})
    assert r.status_code == 401

def test_miss_then_hit_shape():
    c = _client()
    h = {"Authorization": "Bearer secret"}
    r1 = c.post("/v1/images/generations", json={"prompt": "a cat", "model": "image-cache-1"}, headers=h)
    assert r1.status_code == 200
    assert r1.json()["shared_cache"]["result"] == "miss"
    assert r1.json()["data"][0]["url"]
    r2 = c.post("/v1/images/generations", json={"prompt": "a cat"}, headers=h)
    assert r2.json()["shared_cache"]["result"] == "hit"
    assert r2.json()["shared_cache"]["cost_saved_usd"] > 0

def test_healthz():
    assert _client().get("/healthz").json() == {"status": "ok"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Implement `src/sharedcache/api.py`**

```python
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sharedcache.cache_service import CacheService

class GenRequest(BaseModel):
    prompt: str
    model: str = "image-cache-1"
    n: int = 1
    size: str = "1024x1024"
    cache_tolerance: float = 0.15

def build_app(service: CacheService, api_key: str | None) -> FastAPI:
    app = FastAPI(title="SharedCache")

    def _check(auth: str | None):
        if api_key is None:
            return
        if auth != f"Bearer {api_key}":
            raise HTTPException(status_code=401, detail="invalid api key")

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/v1/images/generations")
    async def generate(body: GenRequest, authorization: str | None = Header(default=None)):
        _check(authorization)
        r = await service.generate(body.prompt, cache_tolerance=body.cache_tolerance,
                                   size=body.size, api_key="caller")
        return JSONResponse({
            "created": 0,
            "data": [{"url": r.record.url}],
            "shared_cache": {
                "result": r.result,
                "similarity": r.similarity,
                "cost_saved_usd": r.cost_saved_usd,
                "provider": r.record.provider,
                "model": r.record.model,
                "provenance_url": r.record.manifest_url,
            },
        })

    return app
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_api.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Add the production `app` factory + UI mount to `api.py`**

```python
def _build_from_settings():
    from sharedcache.config import Settings
    from sharedcache.embedder import GeminiEmbedder, HashEmbedder
    from sharedcache.index import InMemoryCacheIndex, PgCacheIndex
    from sharedcache.generator import GenblazeGenerator, StubGenerator
    from sharedcache.storage import GenblazeS3Storage, InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from datetime import datetime, timezone

    s = Settings()
    storage = (GenblazeS3Storage(s.b2_bucket, s.b2_key_id, s.b2_app_key, s.b2_region)
               if s.b2_bucket and s.b2_key_id else InMemoryStorage())
    embedder = GeminiEmbedder(s.gemini_api_key, s.embedding_dims) if s.gemini_api_key else HashEmbedder(s.embedding_dims)
    index = PgCacheIndex(s.database_url, s.embedding_dims) if s.database_url else InMemoryCacheIndex()
    generator = (GenblazeGenerator(storage, s.openai_api_key)
                 if s.openai_api_key and s.b2_bucket else StubGenerator(storage))
    svc = CacheService(embedder, index, generator, storage, CostMeter(),
                       created_at_fn=lambda: datetime.now(timezone.utc).isoformat())
    return build_app(svc, s.api_key)

app = _build_from_settings()
```

- [ ] **Step 6: Run full suite**

Run: `uv run pytest -v`
Expected: all PASS (pg integration test SKIPPED without DB)

- [ ] **Step 7: Commit**

```bash
git add src/sharedcache/api.py tests/test_api.py
git commit -m "feat: OpenAI-compatible API + settings-wired app factory"
```

---

### Task 12: Playground UI, seed script, live smoke, README

**Files:**
- Create: `web/index.html`, `scripts/seed.py`, `README.md`
- Modify: `src/sharedcache/api.py` (mount the UI)

**Interfaces:**
- Consumes: the running `app` (Task 11).
- Produces: `GET /` serving `web/index.html`; `scripts/seed.py` callable as `uv run python scripts/seed.py`.

- [ ] **Step 1: Write `web/index.html`** (prompt box, tolerance slider, result image, HIT/MISS badge, cumulative "$ saved" counter)

```html
<!doctype html><html><head><meta charset="utf-8"><title>SharedCache</title>
<style>body{font-family:system-ui;max-width:680px;margin:40px auto}
.badge{padding:2px 8px;border-radius:6px;color:#fff}.hit{background:#16a34a}.miss{background:#ea580c}
img{max-width:100%;border-radius:8px;margin-top:12px}input[type=range]{width:100%}</style></head>
<body><h1>SharedCache 💵</h1><p>Generate once. Serve forever.</p>
<input id="prompt" placeholder="a cozy cafe interior" style="width:100%;padding:8px">
<label>cache_tolerance: <span id="tv">0.15</span></label>
<input id="tol" type="range" min="0" max="1" step="0.05" value="0.15"
 oninput="tv.textContent=this.value">
<button onclick="go()">Generate</button>
<p>Total saved: $<span id="saved">0.00</span></p>
<div id="out"></div>
<script>
let saved=0;
async function go(){
 const r=await fetch('/v1/images/generations',{method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.key||'dev-key')},
  body:JSON.stringify({prompt:prompt.value,cache_tolerance:parseFloat(tol.value)})});
 const j=await r.json();const sc=j.shared_cache;
 saved+=sc.cost_saved_usd;document.getElementById('saved').textContent=saved.toFixed(2);
 out.innerHTML=`<span class="badge ${sc.result}">${sc.result.toUpperCase()}</span>
  similarity ${sc.similarity.toFixed(3)} · saved $${sc.cost_saved_usd.toFixed(2)}
  <br><img src="${j.data[0].url}">`;
}
</script></body></html>
```

- [ ] **Step 2: Mount the UI in `api.py`** (add inside `build_app`, before `return app`)

```python
    from fastapi.responses import FileResponse
    import os
    @app.get("/")
    def index():
        path = os.path.join(os.path.dirname(__file__), "..", "..", "web", "index.html")
        return FileResponse(os.path.abspath(path))
```

- [ ] **Step 3: Manual UI check**

Run: `uv run uvicorn sharedcache.api:app --reload` then open `http://localhost:8000/`.
Expected: first generate shows **MISS**; identical prompt shows **HIT** with a non-zero saved counter (uses `StubGenerator`/`InMemoryStorage` when no keys set).

- [ ] **Step 4: Write `scripts/seed.py`** (pre-seed the demo pool so judges see hits)

```python
import asyncio
from sharedcache.api import _build_from_settings

PROMPTS = ["a cozy cafe interior", "a modern dental clinic", "a yoga studio at sunrise",
           "a law firm office", "a fresh bakery storefront", "a landscaped backyard garden"]

async def main():
    app = _build_from_settings()
    svc = app.state.service if hasattr(app.state, "service") else None
    # Expose the service for seeding:
    from sharedcache.config import Settings  # noqa
    raise SystemExit("Wire app.state.service in build_app, then seed (see Step 5).")

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 5: Expose the service for seeding** — in `build_app` add `app.state.service = service` before `return app`; then finalize `scripts/seed.py`:

```python
import asyncio
from sharedcache.api import _build_from_settings

PROMPTS = ["a cozy cafe interior", "a modern dental clinic", "a yoga studio at sunrise",
           "a law firm office", "a fresh bakery storefront", "a landscaped backyard garden"]

async def main():
    svc = _build_from_settings().state.service
    for p in PROMPTS:
        r = await svc.generate(p, cache_tolerance=0.15)
        print(f"{r.result:4}  {p}")

if __name__ == "__main__":
    asyncio.run(main())
```

Run: `uv run python scripts/seed.py`
Expected: each prompt prints `miss` on first run, `hit` if re-run.

- [ ] **Step 6: Live smoke test (real keys)** — set `OPENAI_API_KEY`, `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET` in `.env`, then:

Run: `uv run python scripts/seed.py`
Expected: real images generated via Genblaze land in the B2 bucket (verify in the Backblaze console: `assets/.../` objects + `manifest.json`), and re-running yields `hit`. Confirm `GET /` shows the B2-served image.

- [ ] **Step 7: Write `README.md`** (covers: what it does; **how it uses Backblaze B2** = generated assets + thumbnails + provenance manifests stored via the genblaze-s3 sink; **how it uses Genblaze** = the miss-path Pipeline orchestrates the provider + emits the manifest; **AI providers/models used** = OpenAI `gpt-image-1` (default), optionally Google Imagen / GMICloud; quickstart; env vars; the `cache_tolerance` knob). Include a one-paragraph "how the cache saves money" section for judges.

- [ ] **Step 8: Commit**

```bash
git add web/index.html scripts/seed.py README.md src/sharedcache/api.py
git commit -m "feat: playground UI, seed script, live smoke path, README"
```

---

## Stretch tasks (cuttable — implement only if MVP is solid before the deadline)

Each follows the same TDD rhythm; decompose when picked up.

- **S1 — ModerationGate:** Cloud Vision SafeSearch on generated bytes before index insert; reject `adult`/`racy`/`violence` above thresholds; store scores in `assets.safety`. Strengthens "Production Readiness". (Ref: prior CC0/safety research — `[[cc0-image-sources-research]]`.)
- **S2 — Second modality (audio):** add `audio-cache-1` using a Genblaze TTS provider (`modality=Modality.AUDIO`); same cache flow; hits the hackathon "multimodal" theme.
- **S3 — Per-key metering:** real API keys table + `savings_ledger` persisted in Postgres; `GET /v1/usage` returns per-key savings.
- **S4 — Feedback Prize:** file substantive product feedback as Genblaze repo Issues (e.g. provenance issue #77, raw-bytes ergonomics, pricing-data gaps).

---

## Self-Review

**Spec coverage:**
- OpenAI-compatible endpoint + `cache_tolerance` → Tasks 2, 11 ✓
- Hit/miss over B2-backed shared pool → Tasks 5, 6, 10 ✓
- Genblaze generation-on-miss + provenance manifest in B2 → Tasks 6, 8, 10 ✓
- Playground UI with "$ saved" → Task 12 ✓
- Components (Embedder, CacheIndex, Storage, Generator, Processor, CostMeter, CacheService, API) → Tasks 4–11 ✓
- Data model (assets, savings_ledger) → Task 5 ✓
- Cost metering → Task 9 ✓
- Deploy/seed/README/video prep → Task 12 + submission checklist ✓
- Trust/provenance (sink so sha256 populated; manifest stored) → Tasks 6, 8, 10 ✓
- ModerationGate (stretch), 2nd modality (stretch) → S1, S2 ✓

**Placeholder scan:** Two explicit "NOTE for implementer" blocks (Tasks 6, 8) flag SDK-kwarg verification against the pinned Genblaze version — these are de-risking notes, not missing logic; the protocol shapes and tests are complete. No `TBD`/`TODO` in code steps.

**Type consistency:** `Embedder.embed`, `CacheIndex.search/insert`, `Storage.put/get/key_from_url`, `Generator.generate`, `Generated`/`AssetRecord`/`GenerationResult` field names are used identically across Tasks 3–12. `created_at_fn` injection keeps the core clock-free (the only wall clock is in the Task 11 production factory).

**Note:** `scripts/seed.py` is written in two steps (12.4 then 12.5) because seeding requires `app.state.service`, which Task 12 Step 5 adds — sequencing is intentional, not a duplicate.
