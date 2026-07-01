# Demand-Driven Cache with Background Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn SharedCache into a demand-driven cache that always returns the nearest image immediately, logs and counts every query, and builds the most-requested missing images in an in-process background worker — with multi-size B2 lazy rehosting and a generic GMI-default provider.

**Architecture:** Extends the existing Protocol-per-collaborator design (`Embedder`/`CacheIndex`/`Generator`/`Storage`) with a new `QueryLog` collaborator and a `BackgroundBuilder` worker. The request path never blocks on generation by default; a timer-driven worker ranks pending queries by request count, re-checks the index before generating (so nothing is built twice), and is bounded by a per-tick spend cap. Assets are lazily rehosted to Backblaze B2 in three webp sizes on first serve.

**Tech Stack:** Python 3.11+, FastAPI, pydantic-settings, psycopg3 + pgvector, Pillow, httpx, Genblaze SDK (GMI Cloud provider), pytest + pytest-asyncio.

**Spec:** `docs/superpowers/specs/2026-07-01-demand-driven-cache-design.md`

## Global Constraints

- Python `>=3.11`; keep the package offline-importable (lazy-import all real SDKs: genblaze, psycopg only inside methods/`_conn`, google-genai, httpx clients).
- All new behaviour must be testable offline with `StubGenerator` / `HashEmbedder` / `InMemory*`; set `WORKER_ENABLED=false` in the test environment so no loop starts.
- Follow existing code style: small focused modules, `snake_case`, dataclasses for records, `Protocol` for collaborator interfaces.
- Storage stays on Backblaze **B2** (no Cloudflare R2).
- Default provider is **gmicloud**; assets store a generic `model_used` string + `source` origin (no user-facing `provider`/`model`).
- Every task ends green: `uv run pytest -q` (or `python -m pytest -q`) passes.
- Commit after every task.

## File Structure

**Create:**
- `src/sharedcache/query_log.py` — `QueryStat`, `QueryLog` protocol, `InMemoryQueryLog`, `PgQueryLog`.
- `src/sharedcache/worker.py` — `BackgroundBuilder` (tick + run_forever).
- `src/sharedcache/ratelimit.py` — tiny in-memory sliding-window limiter for key generation.
- `tests/test_query_log.py`, `tests/test_worker.py`, `tests/test_ratelimit.py`, `tests/test_migrate.py`.

**Modify:**
- `src/sharedcache/models.py` — `AssetRecord` (+`medium_url`,`model_used`,`source`,`source_id`; drop `provider`,`model`), `Generated` (same).
- `src/sharedcache/processor.py` — add `derive_sizes`.
- `src/sharedcache/cost_meter.py` — flat `price_usd` estimate.
- `src/sharedcache/index.py` — `update_urls`, new columns, hashed api keys, `queries` unused here.
- `src/sharedcache/cache_service.py` — `storage` property, `ensure_local`, `_build_and_insert`, branching + query logging.
- `src/sharedcache/generator.py` — generic `model_used`/`source`; default gmicloud dispatch.
- `src/sharedcache/config.py` — new settings.
- `src/sharedcache/api.py` — remove `dev-key`, rate-limit keygen, GMI default, response shape, lifespan worker.
- `scripts/migrate.sql` — idempotent + `queries` table.
- `scripts/seed_pd12m.py`, `scripts/seed.py` — `source`/`model_used`/`locally_cached`.
- `.env.example`, `README.md`, `TODO.md`.
- Existing tests: `test_api.py`, `test_cache_service.py`, `test_cache_lazy.py`, `test_generator.py`, `test_index.py`, `test_cost_meter.py`, `test_storage.py`, `test_models.py`.

---

## Task 1: Fix dead `/memory` route (security fix #5)

**Files:**
- Modify: `src/sharedcache/cache_service.py` (add `storage` property)
- Test: `tests/test_api.py`

**Interfaces:**
- Produces: `CacheService.storage` property returning the underlying storage backend.

- [ ] **Step 1: Write the failing test** — append to `tests/test_api.py`:

```python
def test_memory_route_serves_stored_bytes():
    from sharedcache.api import build_app
    from sharedcache.cache_service import CacheService
    from sharedcache.embedder import HashEmbedder
    from sharedcache.index import InMemoryCacheIndex
    from sharedcache.generator import StubGenerator
    from sharedcache.storage import InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from fastapi.testclient import TestClient

    storage = InMemoryStorage()
    storage.put("assets/x/image.webp", b"PNGBYTES", "image/webp")
    svc = CacheService(HashEmbedder(8), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, None))
    r = client.get("/memory/sharedcache/assets/x/image.webp")
    assert r.status_code == 200
    assert r.content == b"PNGBYTES"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api.py::test_memory_route_serves_stored_bytes -v`
Expected: FAIL — 404 (AttributeError on `service.storage` swallowed by the route's `except`).

- [ ] **Step 3: Add the property** — in `src/sharedcache/cache_service.py`, inside `class CacheService`, right after `__init__`:

```python
    @property
    def storage(self):
        return self._storage
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_api.py::test_memory_route_serves_stored_bytes -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/cache_service.py tests/test_api.py
git commit -m "fix: expose CacheService.storage so /memory route serves bytes (#5)"
```

---

## Task 2: Remove the `dev-key` backdoor (security fix #2)

**Files:**
- Modify: `src/sharedcache/api.py:17-42` (`_check`), `src/sharedcache/index.py:20-23` (seed), `.env.example:15`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces: `_check` no longer treats `dev-key` as valid; `InMemoryCacheIndex` starts with an empty key set.

- [ ] **Step 1: Write the failing test** — append to `tests/test_api.py`:

```python
def test_dev_key_is_not_a_backdoor(monkeypatch):
    # With an API_KEY configured, the literal "dev-key" must NOT authenticate.
    from sharedcache.api import build_app
    from sharedcache.cache_service import CacheService
    from sharedcache.embedder import HashEmbedder
    from sharedcache.index import InMemoryCacheIndex
    from sharedcache.generator import StubGenerator
    from sharedcache.storage import InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from fastapi.testclient import TestClient

    storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(8), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    client = TestClient(build_app(svc, api_key="real-secret"))
    r = client.post("/v1/images/generations",
                    json={"prompt": "hi"}, headers={"Authorization": "Bearer dev-key"})
    assert r.status_code == 401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api.py::test_dev_key_is_not_a_backdoor -v`
Expected: FAIL — returns 200 because `token == "dev-key"` short-circuits.

- [ ] **Step 3: Remove the backdoor.** In `src/sharedcache/api.py` `_check`, change the accept line from:

```python
        if token == "dev-key" or (api_key is not None and token == api_key):
            return ""
```
to:
```python
        if api_key is not None and token == api_key:
            return ""
```

In `src/sharedcache/index.py` `InMemoryCacheIndex.__init__`, change:
```python
        self._api_keys: set[str] = {"dev-key"}
```
to:
```python
        self._api_keys: set[str] = set()
```

In `.env.example`, change `API_KEY=dev-key` to `API_KEY=`.

- [ ] **Step 4: Run the full suite** (other tests may have relied on `dev-key`; update any that do to use a real key).

Run: `uv run pytest -q`
Expected: PASS. If a test used `Bearer dev-key` against a configured key, change it to the configured key.

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/api.py src/sharedcache/index.py .env.example tests/test_api.py
git commit -m "fix: remove hardcoded dev-key backdoor (#2)"
```

---

## Task 3: Hash API keys + rate-limit key generation (security fix #1)

**Files:**
- Create: `src/sharedcache/ratelimit.py`, `tests/test_ratelimit.py`
- Modify: `src/sharedcache/index.py` (hash in `add_api_key`/`verify_api_key`), `src/sharedcache/api.py` (`/v1/keys/generate`), `src/sharedcache/config.py`
- Test: `tests/test_index.py`, `tests/test_api.py`

**Interfaces:**
- Produces: `ratelimit.SlidingWindowLimiter(max_events:int, window_seconds:float, now_fn=...)` with `.allow(key:str)->bool`.
- Produces: `InMemoryCacheIndex`/`PgCacheIndex` store `sha256(raw)` hex; `verify_api_key(raw)` hashes before lookup.
- Consumes: `Settings.keygen_rate_per_hour` (Task 4 adds it; here default to 10 via `getattr`).

- [ ] **Step 1: Write the failing limiter test** — `tests/test_ratelimit.py`:

```python
from sharedcache.ratelimit import SlidingWindowLimiter

def test_limiter_allows_then_blocks():
    clock = {"t": 0.0}
    lim = SlidingWindowLimiter(max_events=2, window_seconds=100.0, now_fn=lambda: clock["t"])
    assert lim.allow("ip") is True
    assert lim.allow("ip") is True
    assert lim.allow("ip") is False          # third within window blocked
    clock["t"] = 101.0
    assert lim.allow("ip") is True            # window slid; allowed again

def test_limiter_is_per_key():
    lim = SlidingWindowLimiter(max_events=1, window_seconds=100.0, now_fn=lambda: 0.0)
    assert lim.allow("a") is True
    assert lim.allow("b") is True             # different key, own budget
    assert lim.allow("a") is False
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_ratelimit.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the limiter** — `src/sharedcache/ratelimit.py`:

```python
import time
from collections import defaultdict, deque

class SlidingWindowLimiter:
    """In-memory per-key sliding-window rate limiter. Single-process only."""
    def __init__(self, max_events: int, window_seconds: float, now_fn=time.monotonic) -> None:
        self._max = max_events
        self._window = window_seconds
        self._now = now_fn
        self._events: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self._now()
        q = self._events[key]
        while q and now - q[0] >= self._window:
            q.popleft()
        if len(q) >= self._max:
            return False
        q.append(now)
        return True
```

- [ ] **Step 4: Run limiter test — PASS.** `uv run pytest tests/test_ratelimit.py -v`

- [ ] **Step 5: Write the failing hashing test** — append to `tests/test_index.py`:

```python
def test_api_keys_are_stored_hashed():
    from sharedcache.index import InMemoryCacheIndex
    idx = InMemoryCacheIndex()
    idx.add_api_key("sc-secret")
    # the raw key must not be stored; verification hashes the input
    assert "sc-secret" not in idx._api_keys
    assert idx.verify_api_key("sc-secret") is True
    assert idx.verify_api_key("sc-wrong") is False
```

- [ ] **Step 6: Run to verify it fails.** `uv run pytest tests/test_index.py::test_api_keys_are_stored_hashed -v` → FAIL (raw stored).

- [ ] **Step 7: Hash keys.** In `src/sharedcache/index.py`, add a module-level helper and use it in both indexes:

```python
import hashlib

def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
```

`InMemoryCacheIndex`:
```python
    def verify_api_key(self, key: str) -> bool:
        return _hash_key(key) in self._api_keys

    def add_api_key(self, key: str) -> None:
        self._api_keys.add(_hash_key(key))
```

`PgCacheIndex`:
```python
    def verify_api_key(self, key: str) -> bool:
        try:
            with self._conn() as conn, conn.cursor() as cur:
                cur.execute("SELECT 1 FROM api_keys WHERE key = %s", (_hash_key(key),))
                return cur.fetchone() is not None
        except Exception:
            return False

    def add_api_key(self, key: str) -> None:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO api_keys (key) VALUES (%s) ON CONFLICT DO NOTHING",
                        (_hash_key(key),))
            conn.commit()
```

- [ ] **Step 8: Run hashing test — PASS.**

- [ ] **Step 9: Write the failing rate-limit route test** — append to `tests/test_api.py`:

```python
def test_keygen_is_rate_limited():
    from sharedcache.api import build_app
    from sharedcache.cache_service import CacheService
    from sharedcache.embedder import HashEmbedder
    from sharedcache.index import InMemoryCacheIndex
    from sharedcache.generator import StubGenerator
    from sharedcache.storage import InMemoryStorage
    from sharedcache.cost_meter import CostMeter
    from fastapi.testclient import TestClient

    storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(8), InMemoryCacheIndex(), StubGenerator(storage),
                       storage, CostMeter(), created_at_fn=lambda: "t")
    app = build_app(svc, None, keygen_rate_per_hour=3)
    client = TestClient(app)
    codes = [client.post("/v1/keys/generate").status_code for _ in range(4)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429
```

- [ ] **Step 10: Run to verify it fails** — FAIL (`build_app` has no `keygen_rate_per_hour`).

- [ ] **Step 11: Wire the limiter into `build_app`.** Change the signature and the route in `src/sharedcache/api.py`:

```python
def build_app(service: CacheService, api_key: str | None, *, keygen_rate_per_hour: int = 10) -> FastAPI:
    from sharedcache.ratelimit import SlidingWindowLimiter
    app = FastAPI(title="SharedCache")
    _keygen_limiter = SlidingWindowLimiter(max_events=keygen_rate_per_hour, window_seconds=3600.0)
```

Route (add `request: Request`, import `Request` from fastapi):
```python
    @app.post("/v1/keys/generate")
    def generate_api_key(request: Request):
        client_ip = request.client.host if request.client else "unknown"
        if not _keygen_limiter.allow(client_ip):
            raise HTTPException(status_code=429, detail="Too many key requests; try again later")
        import secrets, time as _t
        new_key = f"sc-{secrets.token_urlsafe(24)}"
        try:
            service._index.add_api_key(new_key)
            return {"key": new_key, "created_at": _t.time()}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate API Key: {e}")
```

In `_build_from_settings`, pass `keygen_rate_per_hour=s.keygen_rate_per_hour` (Task 4 adds the setting; until then use `getattr(s, "keygen_rate_per_hour", 10)`).

- [ ] **Step 12: Run full suite — PASS.** `uv run pytest -q`

- [ ] **Step 13: Commit**

```bash
git add src/sharedcache/ratelimit.py src/sharedcache/index.py src/sharedcache/api.py \
        tests/test_ratelimit.py tests/test_index.py tests/test_api.py
git commit -m "fix: hash api keys + rate-limit key generation (#1)"
```

---

## Task 4: Config for GMI default + worker + pricing

**Files:**
- Modify: `src/sharedcache/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces settings: `default_provider="gmicloud"`, `default_image_model="gpt-image-1"` (operator overrides for GMI), `image_price_usd=0.04`, `worker_enabled=True`, `worker_interval_seconds=300`, `worker_batch_size=5`, `worker_max_spend_usd=5.0`, `keygen_rate_per_hour=10`.

- [ ] **Step 1: Write the failing test** — append to `tests/test_config.py`:

```python
def test_new_defaults(monkeypatch):
    for k in ("DEFAULT_PROVIDER", "IMAGE_PRICE_USD", "WORKER_ENABLED",
              "WORKER_INTERVAL_SECONDS", "WORKER_BATCH_SIZE", "WORKER_MAX_SPEND_USD",
              "KEYGEN_RATE_PER_HOUR"):
        monkeypatch.delenv(k, raising=False)
    from sharedcache.config import Settings
    s = Settings(_env_file=None)
    assert s.default_provider == "gmicloud"
    assert s.image_price_usd == 0.04
    assert s.worker_enabled is True
    assert s.worker_interval_seconds == 300
    assert s.worker_batch_size == 5
    assert s.worker_max_spend_usd == 5.0
    assert s.keygen_rate_per_hour == 10
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_config.py::test_new_defaults -v`

- [ ] **Step 3: Add the settings** — append fields to `Settings` in `src/sharedcache/config.py`:

```python
    default_provider: str = "gmicloud"
    image_price_usd: float = 0.04
    worker_enabled: bool = True
    worker_interval_seconds: int = 300
    worker_batch_size: int = 5
    worker_max_spend_usd: float = 5.0
    keygen_rate_per_hour: int = 10
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/config.py tests/test_config.py
git commit -m "feat: config for GMI default, worker, and flat pricing"
```

---

## Task 5: Generic asset model (`model_used`/`source`) + flat pricing

**Files:**
- Modify: `src/sharedcache/models.py`, `src/sharedcache/generator.py`, `src/sharedcache/cost_meter.py`, `src/sharedcache/index.py`, `src/sharedcache/cache_service.py`, `src/sharedcache/api.py`
- Test: `tests/test_models.py`, `tests/test_generator.py`, `tests/test_cost_meter.py`, `tests/test_cache_service.py`, `tests/test_api.py`

**Interfaces:**
- Produces: `AssetRecord(id, prompt, url, thumb_url, medium_url, model_used, source, source_id, content_hash, width, height, mime, manifest_url, created_at, source_url=None, locally_cached=True)`.
- Produces: `Generated(url, content_hash, width, height, mime, model_used, source, manifest_json, manifest_hash, storage_key)`.
- Produces: `CostMeter(price_usd=0.04)` with `record_hit(api_key, asset_id)->float` and `cost_saved()->float`.
- Produces: `Generator.generate(..., provider_api_key=None)` returns `Generated` with `model_used`/`source`.

- [ ] **Step 1: Update the record dataclasses** — replace `AssetRecord` and `Generated` in `src/sharedcache/models.py`:

```python
from dataclasses import dataclass

@dataclass
class AssetRecord:
    id: str
    prompt: str
    url: str                 # large webp
    thumb_url: str | None
    medium_url: str | None
    model_used: str
    source: str              # "pd12m" | "generated" | "stub"
    source_id: str | None
    content_hash: str
    width: int
    height: int
    mime: str
    manifest_url: str | None
    created_at: str
    source_url: str | None = None
    locally_cached: bool = True

@dataclass
class Generated:
    url: str
    content_hash: str
    width: int
    height: int
    mime: str
    model_used: str
    source: str
    manifest_json: str
    manifest_hash: str
    storage_key: str
```

- [ ] **Step 2: Update the models test** — rewrite `tests/test_models.py` to construct with the new fields:

```python
from sharedcache.models import AssetRecord, Generated

def test_asset_record_fields():
    r = AssetRecord(id="1", prompt="p", url="u", thumb_url=None, medium_url=None,
                    model_used="m", source="generated", source_id=None, content_hash="h",
                    width=1, height=1, mime="image/webp", manifest_url=None, created_at="t")
    assert r.locally_cached is True and r.source == "generated"

def test_generated_fields():
    g = Generated(url="u", content_hash="h", width=1, height=1, mime="image/webp",
                  model_used="m", source="generated", manifest_json="{}", manifest_hash="x",
                  storage_key="k")
    assert g.model_used == "m"
```

- [ ] **Step 3: Update `StubGenerator`** in `src/sharedcache/generator.py` — parse provider only to derive `model_used`, set `source="stub"`:

```python
    async def generate(self, prompt, *, model, size="1024x1024", provider_api_key=None):
        w, h = (int(x) for x in size.split("x"))
        seed = int(hashlib.sha256(prompt.encode()).hexdigest(), 16) % 1000
        data = _solid_png(w, h, seed)
        content_hash = hashlib.sha256(data).hexdigest()
        key = f"assets/{content_hash}/original.png"
        url = self._storage.put(key, data, "image/png")
        inner_model = model
        if model.startswith("shared-cache-"):
            parts = model.split("-")
            if len(parts) >= 4:
                inner_model = "-".join(parts[3:])
        manifest = {"schema_version": "1.5", "prompt": prompt, "model": inner_model,
                    "sha256": content_hash, "media_type": "image/png", "size_bytes": len(data)}
        manifest_json = json.dumps(manifest, sort_keys=True)
        manifest_hash = hashlib.sha256(manifest_json.encode()).hexdigest()
        return Generated(url=url, content_hash=content_hash, width=w, height=h, mime="image/png",
                         model_used=inner_model, source="stub",
                         manifest_json=manifest_json, manifest_hash=manifest_hash, storage_key=key)
```

- [ ] **Step 4: Update `GenblazeGenerator`** — default dispatch to gmicloud, return `model_used`/`source`. Replace the provider-parse default and the final `Generated`:

```python
        provider_name = "gmicloud"
        inner_model = model
        if model.startswith("shared-cache-"):
            parts = model.split("-")
            if len(parts) >= 4:
                provider_name = parts[2]
                inner_model = "-".join(parts[3:])
```
Keep the existing per-provider dispatch block (openai/google/gmicloud) unchanged. Final return:
```python
        return Generated(url=asset.url, content_hash=asset.sha256,
                         width=asset.width or 0, height=asset.height or 0, mime=asset.media_type,
                         model_used=inner_model, source="generated",
                         manifest_json=manifest_json, manifest_hash=result.manifest.canonical_hash,
                         storage_key=key)
```

- [ ] **Step 5: Update `test_generator.py`** — assert the stub returns `model_used`/`source`:

```python
import asyncio
from sharedcache.generator import StubGenerator
from sharedcache.storage import InMemoryStorage

def test_stub_sets_model_used_and_source():
    g = asyncio.run(StubGenerator(InMemoryStorage()).generate(
        "p", model="shared-cache-gmicloud-flux", size="8x8"))
    assert g.model_used == "flux"
    assert g.source == "stub"
```
(Keep the existing google-requires-key test.)

- [ ] **Step 6: Flat `CostMeter`** — rewrite `src/sharedcache/cost_meter.py`:

```python
from dataclasses import dataclass, field

@dataclass
class CostMeter:
    price_usd: float = 0.04
    _ledger: list[tuple[str | None, str, float]] = field(default_factory=list)

    def record_hit(self, api_key: str | None, asset_id: str) -> float:
        self._ledger.append((api_key, asset_id, self.price_usd))
        return self.price_usd

    def total_saved(self) -> float:
        return round(sum(s for _, _, s in self._ledger), 5)
```
Rewrite `tests/test_cost_meter.py`:
```python
from sharedcache.cost_meter import CostMeter

def test_record_hit_returns_flat_price_and_accumulates():
    m = CostMeter(price_usd=0.04)
    assert m.record_hit("caller", "a1") == 0.04
    m.record_hit("caller", "a2")
    assert m.total_saved() == 0.08
```
Delete `src/sharedcache/pricing.py` and `tests/test_pricing.py` if present (grep first: `grep -rn pricing src tests`). Remove the `from sharedcache.pricing import price_usd` import.

- [ ] **Step 7: Update `PgCacheIndex` columns** in `src/sharedcache/index.py` — insert/select `model_used, source, source_id, medium_url` instead of `provider, model`:

```python
    def insert(self, record, embedding):
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO assets (id, prompt, url, thumb_url, medium_url, model_used,
                       source, source_id, content_hash, width, height, mime, manifest_url,
                       source_url, locally_cached, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (record.id, record.prompt, record.url, record.thumb_url, record.medium_url,
                 record.model_used, record.source, record.source_id, record.content_hash,
                 record.width, record.height, record.mime, record.manifest_url,
                 record.source_url, record.locally_cached, np.asarray(embedding, dtype=float)))
            conn.commit()
```
And in `search`, select the same columns and build `AssetRecord(... medium_url=row[..], model_used=.., source=.., source_id=..)`. (Match column order exactly; `1 - (embedding <=> %s)` stays last.)

- [ ] **Step 8: Update `cache_service.py` + `api.py` construction sites** so they compile with the new fields:
  - `cache_service.py` miss-path builds `AssetRecord(... medium_url=None, model_used=gen.model_used, source=gen.source, source_id=None ...)` and calls `self._cost.record_hit(api_key, record.id)` (no provider/model args).
  - `api.py` response `shared_cache` block: replace `"provider": r.record.provider, "model": r.record.model` with `"model_used": r.record.model_used, "source": r.record.source` and add `"sizes": {"thumb": r.record.thumb_url, "medium": r.record.medium_url, "large": r.record.url}`.
  - `api.py` `_build_from_settings`: `CostMeter()` → `CostMeter(price_usd=s.image_price_usd)`.

- [ ] **Step 9: Run the full suite; fix any remaining construction sites** (grep `record.provider`, `record.model`, `price_usd(`, `gen.provider`):

Run: `uv run pytest -q`
Expected: PASS after all sites updated.

- [ ] **Step 10: Commit**

```bash
git add src/sharedcache tests
git commit -m "refactor: generic model_used/source on assets + flat cost estimate"
```

---

## Task 6: Multi-size derive + `ensure_local` lazy rehost

**Files:**
- Modify: `src/sharedcache/processor.py`, `src/sharedcache/index.py` (`update_urls`), `src/sharedcache/cache_service.py` (`ensure_local`)
- Test: `tests/test_processor.py`, `tests/test_cache_lazy.py`, `tests/test_index.py`

**Interfaces:**
- Produces: `processor.derive_sizes(image_bytes) -> {"thumb": bytes, "medium": bytes, "large": bytes}` (all webp).
- Produces: `CacheIndex.update_urls(asset_id, *, url, medium_url, thumb_url, width, height, mime, locally_cached)`.
- Produces: `async CacheService.ensure_local(record) -> None` (rehost 3 sizes; on failure log + return).

- [ ] **Step 1: Write the failing `derive_sizes` test** — append to `tests/test_processor.py`:

```python
import io
from PIL import Image
from sharedcache.processor import derive_sizes

def _png(w, h):
    b = io.BytesIO(); Image.new("RGB", (w, h), (10, 20, 30)).save(b, format="PNG"); return b.getvalue()

def test_derive_sizes_produces_three_webp():
    out = derive_sizes(_png(2000, 1000))
    assert set(out) == {"thumb", "medium", "large"}
    for name, cap in (("thumb", 256), ("medium", 768), ("large", 2000)):
        w, h = Image.open(io.BytesIO(out[name])).size
        assert max(w, h) <= cap
        assert Image.open(io.BytesIO(out[name])).format == "WEBP"
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_processor.py::test_derive_sizes_produces_three_webp -v`

- [ ] **Step 3: Implement `derive_sizes`** — append to `src/sharedcache/processor.py`:

```python
def _webp(img, quality: int) -> bytes:
    out = io.BytesIO(); img.convert("RGB").save(out, format="WEBP", quality=quality); return out.getvalue()

def derive_sizes(image_bytes: bytes) -> dict[str, bytes]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        large = _webp(img, 90)
        med = img.convert("RGB"); med.thumbnail((768, 768)); medium = _webp(med, 85)
        th = img.convert("RGB"); th.thumbnail((256, 256)); thumb = _webp(th, 80)
    return {"thumb": thumb, "medium": medium, "large": large}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Add `update_urls`** to both indexes in `src/sharedcache/index.py`, replacing `update_url`.

`InMemoryCacheIndex`:
```python
    def update_urls(self, asset_id, *, url, medium_url, thumb_url, width, height, mime, locally_cached):
        for rec, _ in self._rows:
            if rec.id == asset_id:
                rec.url, rec.medium_url, rec.thumb_url = url, medium_url, thumb_url
                rec.width, rec.height, rec.mime = width, height, mime
                rec.locally_cached = locally_cached
                break
```
`PgCacheIndex`:
```python
    def update_urls(self, asset_id, *, url, medium_url, thumb_url, width, height, mime, locally_cached):
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE assets SET url=%s, medium_url=%s, thumb_url=%s, width=%s, height=%s,
                       mime=%s, locally_cached=%s WHERE id=%s""",
                (url, medium_url, thumb_url, width, height, mime, locally_cached, asset_id))
            conn.commit()
```
Update the `CacheIndex` Protocol to declare `update_urls` (remove `update_url`).

- [ ] **Step 6: Implement `ensure_local`** in `src/sharedcache/cache_service.py`:

```python
    async def ensure_local(self, record) -> None:
        if record.locally_cached:
            return
        try:
            import httpx
            src = record.source_url or record.url
            record.source_url = src
            async with httpx.AsyncClient() as client:
                resp = await client.get(src, follow_redirects=True, timeout=20.0)
                if resp.status_code != 200:
                    raise RuntimeError(f"Download failed with status {resp.status_code}")
                orig = resp.content
            from sharedcache.processor import derive_sizes, dimensions
            sizes = derive_sizes(orig)
            w, h = dimensions(sizes["large"])
            large_url = self._storage.put(f"assets/{record.id}/image.webp", sizes["large"], "image/webp")
            med_url = self._storage.put(f"assets/{record.id}/medium.webp", sizes["medium"], "image/webp")
            thumb_url = self._storage.put(f"assets/{record.id}/thumb.webp", sizes["thumb"], "image/webp")
            self._index.update_urls(record.id, url=large_url, medium_url=med_url, thumb_url=thumb_url,
                                    width=w, height=h, mime="image/webp", locally_cached=True)
            record.url, record.medium_url, record.thumb_url = large_url, med_url, thumb_url
            record.width, record.height, record.mime, record.locally_cached = w, h, "image/webp", True
        except Exception as e:
            import sys
            print(f"Lazy caching failed for asset {record.id}: {e}", file=sys.stderr)
```

Replace the inline lazy-cache block in `generate` (the `if not record.locally_cached:` body) with `await self.ensure_local(record)`.

- [ ] **Step 7: Rewrite `tests/test_cache_lazy.py`** to assert 3 sizes + a failure path:

```python
import io, pytest
from PIL import Image
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.models import AssetRecord
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter
from sharedcache.generator import StubGenerator

def _jpeg():
    b = io.BytesIO(); Image.new("RGB", (200, 100), "blue").save(b, format="JPEG"); return b.getvalue()

def _seeded_service(monkeypatch, status=200, content=None):
    idx = InMemoryCacheIndex(); storage = InMemoryStorage()
    svc = CacheService(HashEmbedder(8), idx, StubGenerator(storage), storage, CostMeter(),
                       created_at_fn=lambda: "t")
    rec = AssetRecord(id="lazy1", prompt="a red fox", url="https://ext/fox.jpg", thumb_url=None,
                      medium_url=None, model_used="pd12m-clip", source="pd12m", source_id="7",
                      content_hash="pd12m-7", width=200, height=100, mime="image/jpeg",
                      manifest_url=None, created_at="t", source_url="https://ext/fox.jpg",
                      locally_cached=False)
    idx.insert(rec, HashEmbedder(8).embed("a red fox"))

    class FakeResp:
        def __init__(self, c, s): self.content, self.status_code = c, s
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, **kw): return FakeResp(content, status)
    import httpx; monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: FakeClient())
    return svc, idx, rec

@pytest.mark.asyncio
async def test_lazy_rehost_writes_three_sizes(monkeypatch):
    svc, idx, rec = _seeded_service(monkeypatch, content=_jpeg())
    r = await svc.generate("a red fox", cache_tolerance=0.5)
    assert r.result == "hit"
    assert rec.locally_cached is True
    assert rec.url.endswith("image.webp") and rec.medium_url.endswith("medium.webp") \
        and rec.thumb_url.endswith("thumb.webp")

@pytest.mark.asyncio
async def test_lazy_rehost_download_failure_is_graceful(monkeypatch):
    svc, idx, rec = _seeded_service(monkeypatch, status=500, content=b"")
    r = await svc.generate("a red fox", cache_tolerance=0.5)
    assert r.result == "hit"                 # still returns the asset
    assert rec.locally_cached is False        # rehost did not complete
    assert rec.url == "https://ext/fox.jpg"   # original url preserved
```

- [ ] **Step 8: Run the lazy + processor + index tests — PASS.** `uv run pytest tests/test_cache_lazy.py tests/test_processor.py tests/test_index.py -q`

- [ ] **Step 9: Run full suite — PASS.** `uv run pytest -q`

- [ ] **Step 10: Commit**

```bash
git add src/sharedcache tests
git commit -m "feat: multi-size webp lazy rehost via ensure_local + update_urls"
```

---

## Task 7: Idempotent migration + `queries` table (fix #6)

**Files:**
- Modify: `scripts/migrate.sql`
- Test: `tests/test_migrate.py`

**Interfaces:**
- Produces: migration SQL with `ADD COLUMN IF NOT EXISTS` for the new asset columns, a guarded `DROP NOT NULL` on legacy `provider`/`model`, and a `queries` table using the templated dim.

- [ ] **Step 1: Write the failing test** — `tests/test_migrate.py`:

```python
import pathlib
SQL = (pathlib.Path(__file__).parent.parent / "scripts" / "migrate.sql").read_text()

def test_migration_is_idempotent_and_has_queries():
    for col in ("medium_url", "model_used", "source", "source_id", "source_url", "locally_cached"):
        assert f"ADD COLUMN IF NOT EXISTS {col}" in SQL
    assert "CREATE TABLE IF NOT EXISTS queries" in SQL
    assert "DROP NOT NULL" in SQL
    assert "vector(__EMBEDDING_DIMS__)" in SQL  # queries.embedding still templated
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_migrate.py -v`

- [ ] **Step 3: Rewrite `scripts/migrate.sql`.** Fresh `assets` gains the new columns and drops `provider`/`model`; append the evolution block, the guarded `DROP NOT NULL` DO-block, and the `queries` table (exact SQL in spec §10). The `assets` CREATE column list must match `PgCacheIndex.insert` from Task 5. Add:

```sql
CREATE TABLE IF NOT EXISTS queries (
    normalized_prompt TEXT PRIMARY KEY,
    original_prompt   TEXT NOT NULL,
    embedding         vector(__EMBEDDING_DIMS__) NOT NULL,
    count             INT NOT NULL DEFAULT 1,
    status            TEXT NOT NULL DEFAULT 'pending',
    last_asset_id     UUID,
    last_similarity   REAL,
    first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_queries_pending_count
    ON queries (count DESC) WHERE status = 'pending';
```

- [ ] **Step 4: Run — PASS.** Also sanity-check templating: `EMBEDDING_DIMS=8 uv run python scripts/migrate.py | grep -c "vector(8)"` → `2`.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate.sql tests/test_migrate.py
git commit -m "fix: idempotent migration + queries table (#6)"
```

---

## Task 8: `QueryLog` protocol + in-memory & Pg implementations

**Files:**
- Create: `src/sharedcache/query_log.py`, `tests/test_query_log.py`
- Test: `tests/test_query_log.py`, `tests/test_index_pg.py` (Pg path, skip-gated)

**Interfaces:**
- Produces: `normalize_prompt(s)->str`, `QueryStat`, `QueryLog` Protocol, `InMemoryQueryLog`, `PgQueryLog(dsn)`.
- `record(*, prompt, embedding, outcome, asset_id, similarity)`: upsert normalized prompt, `count += 1`; `outcome in {"hit","generated"}` → `status="built"`, `last_asset_id=asset_id`; `outcome=="approximate"` and not already built → `status="pending"`.
- `top_pending(limit)`: `status=="pending"`, ordered by `count` desc.
- `mark_built(normalized_prompt, asset_id)`: set `status="built"`, `last_asset_id`.

- [ ] **Step 1: Write the failing tests** — `tests/test_query_log.py`:

```python
from sharedcache.query_log import InMemoryQueryLog, normalize_prompt

def test_normalize_collapses_and_lowercases():
    assert normalize_prompt("  A  Red   Fox ") == "a red fox"

def test_record_counts_and_ranks_pending():
    q = InMemoryQueryLog()
    q.record(prompt="a red fox", embedding=[0.1], outcome="approximate", asset_id="near1", similarity=0.4)
    q.record(prompt="A RED FOX", embedding=[0.1], outcome="approximate", asset_id="near1", similarity=0.4)
    q.record(prompt="a blue cat", embedding=[0.2], outcome="approximate", asset_id="near2", similarity=0.3)
    top = q.top_pending(10)
    assert [t.normalized_prompt for t in top] == ["a red fox", "a blue cat"]  # fox has count 2
    assert top[0].count == 2

def test_hit_marks_built_and_excluded_from_pending():
    q = InMemoryQueryLog()
    q.record(prompt="sunset", embedding=[0.1], outcome="hit", asset_id="a1", similarity=0.95)
    assert q.top_pending(10) == []

def test_mark_built_promotes_pending():
    q = InMemoryQueryLog()
    q.record(prompt="sunset", embedding=[0.1], outcome="approximate", asset_id="near", similarity=0.4)
    q.mark_built("sunset", "built1")
    assert q.top_pending(10) == []
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_query_log.py -v`

- [ ] **Step 3: Implement `src/sharedcache/query_log.py`:**

```python
from dataclasses import dataclass
from typing import Protocol
import numpy as np
import psycopg
from pgvector.psycopg import register_vector

def normalize_prompt(s: str) -> str:
    return " ".join(s.strip().lower().split())

@dataclass
class QueryStat:
    normalized_prompt: str
    original_prompt: str
    embedding: list[float]
    count: int
    status: str
    last_asset_id: str | None

class QueryLog(Protocol):
    def record(self, *, prompt: str, embedding: list[float], outcome: str,
               asset_id: str | None, similarity: float) -> None: ...
    def top_pending(self, limit: int) -> list[QueryStat]: ...
    def mark_built(self, normalized_prompt: str, asset_id: str) -> None: ...

class InMemoryQueryLog:
    def __init__(self) -> None:
        self._rows: dict[str, QueryStat] = {}

    def record(self, *, prompt, embedding, outcome, asset_id, similarity):
        key = normalize_prompt(prompt)
        row = self._rows.get(key)
        if row is None:
            row = QueryStat(key, prompt, list(embedding), 0, "pending", None)
            self._rows[key] = row
        row.count += 1
        row.original_prompt = prompt
        row.embedding = list(embedding)
        if outcome in ("hit", "generated"):
            row.status = "built"
            row.last_asset_id = asset_id
        elif outcome == "approximate" and row.status != "built":
            row.status = "pending"
            row.last_asset_id = asset_id

    def top_pending(self, limit):
        pend = [r for r in self._rows.values() if r.status == "pending"]
        pend.sort(key=lambda r: r.count, reverse=True)
        return pend[:limit]

    def mark_built(self, normalized_prompt, asset_id):
        row = self._rows.get(normalized_prompt)
        if row:
            row.status = "built"
            row.last_asset_id = asset_id

class PgQueryLog:
    def __init__(self, dsn: str):
        self._dsn = dsn

    def _conn(self):
        conn = psycopg.connect(self._dsn); register_vector(conn); return conn

    def record(self, *, prompt, embedding, outcome, asset_id, similarity):
        key = normalize_prompt(prompt)
        status = "built" if outcome in ("hit", "generated") else "pending"
        vec = np.asarray(embedding, dtype=float)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO queries (normalized_prompt, original_prompt, embedding, count,
                       status, last_asset_id, last_similarity)
                   VALUES (%s,%s,%s,1,%s,%s,%s)
                   ON CONFLICT (normalized_prompt) DO UPDATE SET
                       count = queries.count + 1,
                       original_prompt = EXCLUDED.original_prompt,
                       embedding = EXCLUDED.embedding,
                       last_similarity = EXCLUDED.last_similarity,
                       last_seen = now(),
                       last_asset_id = COALESCE(EXCLUDED.last_asset_id, queries.last_asset_id),
                       status = CASE WHEN queries.status = 'built' THEN 'built'
                                     ELSE EXCLUDED.status END""",
                (key, prompt, vec, status, asset_id, similarity))
            conn.commit()

    def top_pending(self, limit):
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT normalized_prompt, original_prompt, embedding, count, status, last_asset_id
                   FROM queries WHERE status='pending' ORDER BY count DESC LIMIT %s""", (limit,))
            return [QueryStat(r[0], r[1], list(r[2]), r[3], r[4],
                              str(r[5]) if r[5] else None) for r in cur.fetchall()]

    def mark_built(self, normalized_prompt, asset_id):
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("UPDATE queries SET status='built', last_asset_id=%s WHERE normalized_prompt=%s",
                        (asset_id, normalized_prompt))
            conn.commit()
```

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_query_log.py -v`

- [ ] **Step 5: Commit**

```bash
git add src/sharedcache/query_log.py tests/test_query_log.py
git commit -m "feat: QueryLog (in-memory + pg) with per-prompt demand counter"
```

---

## Task 9: Wire QueryLog into the request path + approximate-return branching

**Files:**
- Modify: `src/sharedcache/cache_service.py`, `src/sharedcache/api.py`
- Test: `tests/test_cache_service.py`, `tests/test_api.py`

**Interfaces:**
- Consumes: `QueryLog` (Task 8), `ensure_local` (Task 6), `Generated.model_used/source` (Task 5).
- Produces: `CacheService(embedder, index, generator, storage, cost_meter, *, created_at_fn, query_log=None, price_usd=0.04)`; `async generate(prompt, *, cache_tolerance=0.15, size="1024x1024", api_key=None, model="...", provider_api_key=None, force_generate=False)` returning `GenerationResult(result in {"hit","approximate","generated","stub"})`.
- Produces: `async CacheService._build_and_insert(prompt, embedding, *, model, size, provider_api_key=None) -> AssetRecord`.

- [ ] **Step 1: Write the failing branching tests** — append to `tests/test_cache_service.py`:

```python
import pytest
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter
from sharedcache.generator import StubGenerator
from sharedcache.query_log import InMemoryQueryLog

def _svc(qlog):
    s = InMemoryStorage()
    return CacheService(HashEmbedder(16), InMemoryCacheIndex(), StubGenerator(s), s,
                        CostMeter(), created_at_fn=lambda: "t", query_log=qlog)

@pytest.mark.asyncio
async def test_empty_pool_generates_and_logs_built():
    q = InMemoryQueryLog(); svc = _svc(q)
    r = await svc.generate("a cat", cache_tolerance=0.15)
    assert r.result in ("generated", "stub")
    assert q.top_pending(10) == []                 # exact asset now exists

@pytest.mark.asyncio
async def test_miss_returns_nearest_as_approximate_and_logs_pending():
    q = InMemoryQueryLog(); svc = _svc(q)
    await svc.generate("a cat", cache_tolerance=0.15)          # seed one asset
    r = await svc.generate("a totally different galaxy", cache_tolerance=0.0)  # strict floor -> miss
    assert r.result == "approximate"
    assert r.cost_saved_usd > 0
    assert [t.normalized_prompt for t in q.top_pending(10)] == ["a totally different galaxy"]

@pytest.mark.asyncio
async def test_force_generate_builds_even_on_hit():
    q = InMemoryQueryLog(); svc = _svc(q)
    await svc.generate("a cat", cache_tolerance=0.15)
    r = await svc.generate("a cat", cache_tolerance=1.0, force_generate=True)
    assert r.result == "generated"
    assert r.cost_saved_usd == 0.0
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_cache_service.py -q`

- [ ] **Step 3: Refactor `CacheService`.** Update `__init__` and `generate`, add `_build_and_insert`:

```python
import uuid
from sharedcache.floor import similarity_floor
from sharedcache.models import AssetRecord, GenerationResult
from sharedcache.processor import make_thumbnail, dimensions
from sharedcache.query_log import InMemoryQueryLog

class CacheService:
    def __init__(self, embedder, index, generator, storage, cost_meter, *, created_at_fn,
                 query_log=None, price_usd: float = 0.04):
        self._embedder = embedder
        self._index = index
        self._generator = generator
        self._storage = storage
        self._cost = cost_meter
        self._now = created_at_fn
        self._query_log = query_log or InMemoryQueryLog()
        self._price = price_usd

    @property
    def storage(self):
        return self._storage

    async def _build_and_insert(self, prompt, embedding, *, model, size, provider_api_key=None):
        gen = await self._generator.generate(prompt, model=model, size=size,
                                             provider_api_key=provider_api_key)
        original = self._storage.get(gen.storage_key)
        thumb_bytes = make_thumbnail(original)
        w, h = dimensions(original)
        asset_id = str(uuid.uuid4())
        thumb_url = self._storage.put(f"assets/{asset_id}/thumb.webp", thumb_bytes, "image/webp")
        manifest_url = self._storage.put(f"assets/{asset_id}/manifest.json",
                                         gen.manifest_json.encode(), "application/json")
        record = AssetRecord(id=asset_id, prompt=prompt, url=gen.url, thumb_url=thumb_url,
                             medium_url=None, model_used=gen.model_used, source=gen.source,
                             source_id=None, content_hash=gen.content_hash, width=w, height=h,
                             mime=gen.mime, manifest_url=manifest_url, created_at=self._now())
        self._index.insert(record, embedding)
        return record

    async def generate(self, prompt, *, cache_tolerance=0.15, size="1024x1024", api_key=None,
                       model="shared-cache-gmicloud-gpt-image-1", provider_api_key=None,
                       force_generate=False):
        embedding = self._embedder.embed(prompt)
        floor = similarity_floor(cache_tolerance)
        top = self._index.search(embedding, k=1)
        best = top[0] if top else None

        # 1. explicit forced generation wins over everything
        if force_generate:
            rec = await self._build_and_insert(prompt, embedding, model=model, size=size,
                                               provider_api_key=provider_api_key)
            self._query_log.record(prompt=prompt, embedding=embedding, outcome="generated",
                                   asset_id=rec.id, similarity=0.0)
            return GenerationResult(record=rec, result="generated", similarity=0.0, cost_saved_usd=0.0)

        # 2. real hit
        if best and best[1] >= floor:
            record, sim = best
            await self.ensure_local(record)
            saved = self._cost.record_hit(api_key, record.id)
            self._query_log.record(prompt=prompt, embedding=embedding, outcome="hit",
                                   asset_id=record.id, similarity=sim)
            return GenerationResult(record=record, result="hit", similarity=sim, cost_saved_usd=saved)

        # 3. BYOK caller with no good match -> generate exact now
        if provider_api_key:
            rec = await self._build_and_insert(prompt, embedding, model=model, size=size,
                                               provider_api_key=provider_api_key)
            self._query_log.record(prompt=prompt, embedding=embedding, outcome="generated",
                                   asset_id=rec.id, similarity=0.0)
            return GenerationResult(record=rec, result="generated", similarity=0.0, cost_saved_usd=0.0)

        # 4. approximate: return nearest anyway, log demand for the worker
        if best:
            record, sim = best
            await self.ensure_local(record)
            saved = self._cost.record_hit(api_key, record.id)
            self._query_log.record(prompt=prompt, embedding=embedding, outcome="approximate",
                                   asset_id=record.id, similarity=sim)
            return GenerationResult(record=record, result="approximate", similarity=sim,
                                    cost_saved_usd=saved)

        # 5. empty pool: fall back to a synchronous build so we still return an image
        rec = await self._build_and_insert(prompt, embedding, model=model, size=size,
                                           provider_api_key=provider_api_key)
        self._query_log.record(prompt=prompt, embedding=embedding, outcome="generated",
                               asset_id=rec.id, similarity=0.0)
        result = "stub" if rec.source == "stub" else "generated"
        return GenerationResult(record=rec, result=result, similarity=0.0, cost_saved_usd=0.0)
```

(`ensure_local` from Task 6 already lives on the class.)

- [ ] **Step 4: Wire `api.py`.** In `generate` handler pass `force_generate=body.force_generate`; add `force_generate: bool = False` to `GenRequest`; in `_build_from_settings` build one `InMemoryQueryLog`/`PgQueryLog` and pass `query_log=` + `price_usd=s.image_price_usd` to `CacheService`. For Pg: `query_log = PgQueryLog(s.database_url)` when using `PgCacheIndex`, else `InMemoryQueryLog()`.

- [ ] **Step 5: Run cache-service + api tests — PASS.** `uv run pytest tests/test_cache_service.py tests/test_api.py -q`

- [ ] **Step 6: Run full suite — PASS.** `uv run pytest -q`

- [ ] **Step 7: Commit**

```bash
git add src/sharedcache tests
git commit -m "feat: approximate-return branching + per-query demand logging"
```

---

## Task 10: Background builder worker

**Files:**
- Create: `src/sharedcache/worker.py`, `tests/test_worker.py`
- Modify: `src/sharedcache/api.py` (lifespan wiring)
- Test: `tests/test_worker.py`

**Interfaces:**
- Consumes: `CacheService._build_and_insert`, `CacheService._index.search`, `CacheService.ensure_local`, `QueryLog.top_pending/mark_built`, `similarity_floor`.
- Produces: `BackgroundBuilder(service, query_log, *, floor_tolerance=0.15, batch_size=5, interval_seconds=300, max_spend_usd=5.0, price_usd=0.04)` with `async tick()` and `async run_forever()`.

- [ ] **Step 1: Write the failing tests** — `tests/test_worker.py`:

```python
import pytest
from sharedcache.cache_service import CacheService
from sharedcache.embedder import HashEmbedder
from sharedcache.index import InMemoryCacheIndex
from sharedcache.storage import InMemoryStorage
from sharedcache.cost_meter import CostMeter
from sharedcache.generator import StubGenerator
from sharedcache.query_log import InMemoryQueryLog
from sharedcache.worker import BackgroundBuilder

def _svc(q):
    s = InMemoryStorage()
    return CacheService(HashEmbedder(16), InMemoryCacheIndex(), StubGenerator(s), s,
                        CostMeter(), created_at_fn=lambda: "t", query_log=q)

@pytest.mark.asyncio
async def test_tick_builds_pending_and_clears_queue():
    q = InMemoryQueryLog(); svc = _svc(q)
    for _ in range(3):
        q.record(prompt="popular", embedding=svc._embedder.embed("popular"),
                 outcome="approximate", asset_id=None, similarity=0.1)
    q.record(prompt="rare", embedding=svc._embedder.embed("rare"),
             outcome="approximate", asset_id=None, similarity=0.1)
    w = BackgroundBuilder(svc, q, batch_size=5, max_spend_usd=100.0, price_usd=0.04)
    await w.tick()
    assert q.top_pending(10) == []                 # both built
    assert len(svc._index.search(svc._embedder.embed("popular"), 1)) == 1

@pytest.mark.asyncio
async def test_tick_rechecks_and_skips_when_match_exists(monkeypatch):
    from sharedcache.models import AssetRecord
    q = InMemoryQueryLog(); svc = _svc(q)
    emb = svc._embedder.embed("a cat")
    # Insert a matching asset directly into the index (as if built in a previous tick),
    # while the query for the same prompt is still logged as pending.
    rec = AssetRecord(id="existing", prompt="a cat", url="u", thumb_url=None, medium_url=None,
                      model_used="m", source="generated", source_id=None, content_hash="h",
                      width=1, height=1, mime="image/webp", manifest_url=None, created_at="t")
    svc._index.insert(rec, emb)
    q.record(prompt="a cat", embedding=emb, outcome="approximate", asset_id=None, similarity=0.1)
    calls = {"n": 0}
    orig = svc._build_and_insert
    async def counting(*a, **k):
        calls["n"] += 1; return await orig(*a, **k)
    monkeypatch.setattr(svc, "_build_and_insert", counting)
    w = BackgroundBuilder(svc, q, floor_tolerance=0.15, batch_size=5, max_spend_usd=100.0)
    await w.tick()
    assert calls["n"] == 0                          # re-check found the existing asset
    assert q.top_pending(10) == []                  # marked built via link to "existing"

@pytest.mark.asyncio
async def test_spend_cap_halts_tick():
    q = InMemoryQueryLog(); svc = _svc(q)
    for i in range(5):
        q.record(prompt=f"p{i}", embedding=svc._embedder.embed(f"p{i}"),
                 outcome="approximate", asset_id=None, similarity=0.1)
    w = BackgroundBuilder(svc, q, batch_size=5, max_spend_usd=0.04, price_usd=0.04)
    await w.tick()
    assert len(q.top_pending(10)) == 4              # only one built before cap hit
```

- [ ] **Step 2: Run — FAIL.** `uv run pytest tests/test_worker.py -q`

- [ ] **Step 3: Implement `src/sharedcache/worker.py`:**

```python
import asyncio
import sys
from sharedcache.floor import similarity_floor

class BackgroundBuilder:
    def __init__(self, service, query_log, *, floor_tolerance: float = 0.15, batch_size: int = 5,
                 interval_seconds: int = 300, max_spend_usd: float = 5.0, price_usd: float = 0.04):
        self._svc = service
        self._q = query_log
        self._floor = similarity_floor(floor_tolerance)
        self._batch = batch_size
        self._interval = interval_seconds
        self._max_spend = max_spend_usd
        self._price = price_usd

    async def tick(self) -> None:
        spent = 0.0
        for stat in self._q.top_pending(self._batch):
            # re-check: an asset may have appeared since this query was logged
            top = self._svc._index.search(stat.embedding, k=1)
            if top and top[0][1] >= self._floor:
                self._q.mark_built(stat.normalized_prompt, top[0][0].id)
                continue
            if spent + self._price > self._max_spend:
                break
            rec = await self._svc._build_and_insert(
                stat.original_prompt, stat.embedding,
                model="shared-cache-gmicloud-gpt-image-1", size="1024x1024")
            await self._svc.ensure_local(rec)
            self._q.mark_built(stat.normalized_prompt, rec.id)
            spent += self._price

    async def run_forever(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception as e:
                print(f"BackgroundBuilder tick failed: {e}", file=sys.stderr)
            await asyncio.sleep(self._interval)
```

Note the spend-cap check is `spent + price > max_spend` **before** building, so `max_spend=0.04` allows exactly one build.

- [ ] **Step 4: Run — PASS.** `uv run pytest tests/test_worker.py -q`

- [ ] **Step 5: Wire the lifespan in `api.py`.** Replace the app construction with a lifespan that starts the worker only when enabled and a server key exists. In `_build_from_settings`, after building `svc`, compute `worker_enabled = s.worker_enabled and bool(s.openai_api_key or s.gemini_api_key or s.gmicloud_api_key)` and pass a config object / closure into `build_app`. Minimal wiring:

```python
    from contextlib import asynccontextmanager
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = None
        if worker_cfg and worker_cfg["enabled"]:
            from sharedcache.worker import BackgroundBuilder
            builder = BackgroundBuilder(service, service._query_log,
                                        batch_size=worker_cfg["batch"],
                                        interval_seconds=worker_cfg["interval"],
                                        max_spend_usd=worker_cfg["max_spend"],
                                        price_usd=worker_cfg["price"])
            task = asyncio.create_task(builder.run_forever())
        try:
            yield
        finally:
            if task:
                task.cancel()
    app = FastAPI(title="SharedCache", lifespan=lifespan)
```

`build_app` gains a `worker_cfg: dict | None = None` keyword; `_build_from_settings` passes
`{"enabled": worker_enabled, "batch": s.worker_batch_size, "interval": s.worker_interval_seconds, "max_spend": s.worker_max_spend_usd, "price": s.image_price_usd}`. Tests call `build_app(..., worker_cfg=None)` so no loop starts (TestClient enters the lifespan).

- [ ] **Step 6: Run full suite — PASS** (ensure `test_api.py` still green with the lifespan; TestClient triggers startup/shutdown).

Run: `uv run pytest -q`

- [ ] **Step 7: Commit**

```bash
git add src/sharedcache/worker.py src/sharedcache/api.py tests/test_worker.py
git commit -m "feat: in-process demand-ranked background builder with re-check + spend cap"
```

---

## Task 11: Update seed scripts for source/model_used/locally_cached

**Files:**
- Modify: `scripts/seed_pd12m.py`, `scripts/seed.py`
- Test: manual (scripts are integration glue; keep a light smoke assert)

**Interfaces:**
- Consumes: new `AssetRecord` fields (Task 5).

- [ ] **Step 1: Update `seed_pd12m.py`** `AssetRecord(...)` construction (around the current `provider="public-domain"` block) to:

```python
            record = AssetRecord(
                id=asset_id, prompt=prompt, url=url, thumb_url=None, medium_url=None,
                model_used="pd12m-clip", source="pd12m", source_id=str(item.get("id", idx)),
                content_hash=f"pd12m-{idx}", width=item["width"], height=item["height"],
                mime=item["mime"], manifest_url=None,
                created_at=datetime.now(timezone.utc).isoformat(),
                source_url=url, locally_cached=False)
```

- [ ] **Step 2: Verify `seed.py`** still works — it calls `svc.generate(p, cache_tolerance=0.15)`; no record construction, so no change needed. Run offline:

Run: `WORKER_ENABLED=false uv run python scripts/seed.py`
Expected: prints `generated`/`stub`/`hit`/`approximate` per prompt without error.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed_pd12m.py
git commit -m "chore: seed PD12M with source/model_used/locally_cached fields"
```

---

## Task 12: Docs + response-shape README + branding note

**Files:**
- Modify: `README.md`, `TODO.md`, `web/index.html` (optional branding), `.env.example`
- Test: none (docs)

- [ ] **Step 1: Update `README.md`** — document the demand-driven flow (always-return-nearest, `approximate` status, background worker, `sizes` map, `force_generate`), the new env vars (Task 4), GMI-default provider, and the multi-size rehost. Update the "Running tests" count after the final suite run.

- [ ] **Step 2: Update `TODO.md`** — check off the shipped items (per-key metering/demand queue, lazy rehost) and move the branding reconciliation (WagmiPhotos ↔ SharedCache) into an explicit task; note storage stays B2.

- [ ] **Step 3: Add `.env.example` entries** for the new settings with comments:

```
DEFAULT_PROVIDER=gmicloud
DEFAULT_IMAGE_MODEL=
IMAGE_PRICE_USD=0.04
WORKER_ENABLED=true
WORKER_INTERVAL_SECONDS=300
WORKER_BATCH_SIZE=5
WORKER_MAX_SPEND_USD=5.0
KEYGEN_RATE_PER_HOUR=10
```

- [ ] **Step 4: Final full-suite run and record the number.**

Run: `uv run pytest -q`
Expected: all green; note the count for the README.

- [ ] **Step 5: Commit**

```bash
git add README.md TODO.md .env.example web/index.html
git commit -m "docs: demand-driven cache flow, new env vars, GMI default"
```

---

## Self-Review Notes (author checklist — done)

- **Spec coverage:** §3 data model → Tasks 5/7; §4 interfaces → Tasks 5/6/8/9/10; §5 branching → Task 9; §6 multi-size → Task 6; §7 worker → Task 10; §8 security → Tasks 1/2/3; §9 config → Task 4; §10 migration → Task 7; §11 testing → per-task; seeds → Task 11; docs → Task 12.
- **Type consistency:** `model_used`/`source`/`source_id`/`medium_url` used identically across models, generator, index, cache_service, seeds; `update_urls` signature identical in both indexes and in `ensure_local`; `QueryLog.record/top_pending/mark_built` identical across impls and worker; `_build_and_insert` signature stable between Task 9 (def) and Task 10 (call).
- **Placeholder scan:** none — every code step carries full code; the only operator-set blank is `DEFAULT_IMAGE_MODEL` (intentional, documented).
- **Ordering:** security fixes first (independent), then model → rehost → migration → query log → branching → worker, so each task's suite stays green.
