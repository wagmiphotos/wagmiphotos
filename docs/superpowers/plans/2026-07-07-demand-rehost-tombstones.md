# Demand-Ranked Rehosting + Tombstones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rehost demanded assets first and tombstone assets whose source is permanently gone, so hot images mirror quickly and nothing stays served-but-broken.

**Architecture:** Demand is derived from the existing `queries` table (`SUM(count) GROUP BY last_asset_id`) — no new Worker writes. A `live_assets` SQL view owns the `dead_at IS NULL` liveness invariant; every living-assets read selects from the view, writes keep targeting `assets`. The backfill's rehost pass tombstones on HTTP 404/410 immediately and on retry exhaustion, then best-effort deletes the asset's vector (the Worker already skips orphan vectors, so a dangling vector degrades to a skipped match).

**Tech Stack:** D1/SQLite migration + view, Python (httpx clients in `wagmiphotos-common`, backfill worker, pytest), Cloudflare Worker TypeScript (vitest).

**Spec:** `docs/superpowers/specs/2026-07-07-demand-rehost-tombstones-design.md`

## Global Constraints

- View name is exactly `live_assets` (`SELECT * FROM assets WHERE dead_at IS NULL`); writes always target `assets`, never the view.
- Dead-reason strings are exactly: `http 404`, `http 410`, `retries exhausted`.
- `MAX_REHOST_ATTEMPTS` stays 5 and stays interpolated into SQL from the module constant, as today.
- No `contract.json` changes; no API shape changes (the Worker's `ASSET_COLS` never selects `dead_at`/`dead_reason`).
- Batch sizes keep every `NOT IN (…)` well under D1's 100-bound-param cap (batch ≤ 50); no chunking needed.
- Python tests run from the repo root: `uv run pytest …`. Worker tests run from `projects/worker`: `npm test -- <file>` (full: `npm test`).
- **Deploy order (record in DEPLOY.md if it lists steps, otherwise just follow it):** apply migration 0008 to D1 before deploying the Worker or running the backfill — readers reference the view.

---

### Task 1: Migration 0008 — dead columns, partial index, `live_assets` view

**Files:**
- Create: `projects/worker/migrations/0008_rehost_demand_tombstones.sql`
- Test: `projects/common/tests/test_d1_migration.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `assets.dead_at TEXT` (NULL = alive), `assets.dead_reason TEXT`, partial index `idx_assets_rehostable`, view `live_assets`. Tasks 2 and 5 select `FROM live_assets`.

- [ ] **Step 1: Write the failing tests**

In `projects/common/tests/test_d1_migration.py`, extend the columns assertion inside `test_migrations_create_tables_and_columns` — add the two new columns to the existing `assets` expectation:

```python
    assert {"id", "prompt", "source", "source_id", "model_used", "content_hash", "width",
            "height", "mime", "source_url", "locally_cached", "created_at",
            "rehost_attempts", "dead_at", "dead_reason"} <= cols["assets"]
```

and append a new test at the end of the file:

```python
def test_0008_view_and_index(conn):
    views = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='view'")}
    assert "live_assets" in views
    idx = {r[1] for r in conn.execute("PRAGMA index_list(assets)")}
    assert any("rehostable" in name for name in idx)
    # the view filters dead rows and exposes the same columns as assets
    conn.execute(d1_client.INSERT_ASSET_SQL, ASSET_PARAMS)
    assert conn.execute("SELECT id FROM live_assets").fetchall() == [("a1",)]
    conn.execute("UPDATE assets SET dead_at=datetime('now') WHERE id='a1'")
    assert conn.execute("SELECT id FROM live_assets").fetchall() == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run (repo root): `uv run pytest projects/common/tests/test_d1_migration.py -q`
Expected: `test_migrations_create_tables_and_columns` FAILS (missing `dead_at`/`dead_reason`) and `test_0008_view_and_index` FAILS (`live_assets` not in views).

- [ ] **Step 3: Write the migration**

Create `projects/worker/migrations/0008_rehost_demand_tombstones.sql`:

```sql
-- Demand-ranked rehosting + tombstones (spec 2026-07-07-demand-rehost-tombstones).
-- dead_at doubles as the liveness flag and the audit timestamp; dead_reason is a
-- short cause: 'http 404', 'http 410', 'retries exhausted'.
-- live_assets owns the dead_at IS NULL invariant: every read path that wants
-- living assets selects FROM live_assets; writes keep targeting assets.
-- NOTE: SQLite expands the view's * at creation time — any later migration that
-- adds asset columns must DROP VIEW live_assets and recreate it.
ALTER TABLE assets ADD COLUMN dead_at TEXT;
ALTER TABLE assets ADD COLUMN dead_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_assets_rehostable ON assets(rowid)
  WHERE locally_cached = 0 AND dead_at IS NULL;
CREATE VIEW IF NOT EXISTS live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
```

- [ ] **Step 4: Run tests to verify they pass**

Run (repo root): `uv run pytest projects/common/tests/test_d1_migration.py -q`
Expected: PASS (all tests — the untouched ones prove 0001–0007 semantics survived).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/migrations/0008_rehost_demand_tombstones.sql projects/common/tests/test_d1_migration.py
git commit -m "feat(d1): migration 0008 — dead_at/dead_reason, rehostable index, live_assets view"
```

---

### Task 2: Demand-ranked selection + tombstone methods in `d1_client.py`

**Files:**
- Modify: `projects/common/src/wagmiphotos/common/d1_client.py` (constants at lines ~55-66, methods `asset_exists`/`assets_needing_rehost`/`increment_rehost_attempts` at lines ~128-143)
- Test: `projects/common/tests/test_d1_migration.py`, `projects/common/tests/test_d1_client.py`

**Interfaces:**
- Consumes: Task 1's `live_assets` view and dead columns.
- Produces (Task 4 relies on these exact signatures):
  - `DEMANDED_REHOSTS_SQL: str` and `trickle_rehosts_sql(n_exclude: int) -> str` (module level; replace `ASSETS_NEEDING_REHOST_SQL`)
  - `MARK_ASSET_DEAD_SQL: str`
  - `D1Client.assets_needing_rehost(limit: int) -> list[AssetRecord]` (same signature, now demand-first)
  - `D1Client.increment_rehost_attempts(asset_id: str) -> int` (was `-> None`; returns the new attempt count, 0 if the row is missing)
  - `D1Client.mark_asset_dead(asset_id: str, reason: str) -> None` (idempotent; first reason wins)

- [ ] **Step 1: Write the failing migration-suite tests (SQL semantics)**

In `projects/common/tests/test_d1_migration.py`, add two helpers after `_seed_query`:

```python
def _seed_uncached_asset(conn, asset_id):
    params = list(ASSET_PARAMS)
    params[0] = asset_id
    params[LOCALLY_CACHED_IDX] = 0
    conn.execute(d1_client.INSERT_ASSET_SQL, params)


def _seed_demand(conn, prompt, asset_id, count):
    _seed_query(conn, prompt, count=count)
    conn.execute("UPDATE queries SET last_asset_id=? WHERE normalized_prompt=?",
                 [asset_id, prompt])
```

Replace `test_rehost_sql_filters_attempts_and_increments` with:

```python
def test_rehost_sql_filters_attempts_and_increments(conn):
    _seed_uncached_asset(conn, "a1")
    rows = conn.execute(d1_client.trickle_rehosts_sql(0), [5]).fetchall()
    assert len(rows) == 1
    for i in range(5):
        n = conn.execute(d1_client.INCREMENT_REHOST_ATTEMPTS_SQL, ["a1"]).fetchone()[0]
        assert n == i + 1                    # RETURNING reports the new count
    assert conn.execute(d1_client.trickle_rehosts_sql(0), [5]).fetchall() == []
```

Append new tests:

```python
def test_demanded_rehosts_orders_by_summed_count(conn):
    for aid in ("cold", "warm", "hot"):
        _seed_uncached_asset(conn, aid)
    _seed_demand(conn, "p1", "hot", 9)
    _seed_demand(conn, "p2", "hot", 4)       # SUM(hot)=13
    _seed_demand(conn, "p3", "warm", 5)
    rows = conn.execute(d1_client.DEMANDED_REHOSTS_SQL, [5]).fetchall()
    assert [r[0] for r in rows] == ["hot", "warm"]   # demand DESC; cold has none


def test_trickle_sql_excludes_picked_ids(conn):
    _seed_uncached_asset(conn, "a")
    _seed_uncached_asset(conn, "b")
    rows = conn.execute(d1_client.trickle_rehosts_sql(1), ["a", 5]).fetchall()
    assert [r[0] for r in rows] == ["b"]


def test_dead_assets_excluded_everywhere(conn):
    _seed_uncached_asset(conn, "a1")
    _seed_demand(conn, "p1", "a1", 5)
    conn.execute(d1_client.MARK_ASSET_DEAD_SQL, ["http 404", "a1"])
    assert conn.execute(d1_client.DEMANDED_REHOSTS_SQL, [5]).fetchall() == []
    assert conn.execute(d1_client.trickle_rehosts_sql(0), [5]).fetchall() == []
    assert conn.execute(d1_client.ASSET_EXISTS_SQL, ["a1"]).fetchall() == []
    dead_at, reason = conn.execute(
        "SELECT dead_at, dead_reason FROM assets WHERE id='a1'").fetchone()
    assert dead_at is not None and reason == "http 404"


def test_mark_asset_dead_idempotent_first_reason_wins(conn):
    _seed_uncached_asset(conn, "a1")
    conn.execute(d1_client.MARK_ASSET_DEAD_SQL, ["http 404", "a1"])
    conn.execute(d1_client.MARK_ASSET_DEAD_SQL, ["retries exhausted", "a1"])
    assert conn.execute(
        "SELECT dead_reason FROM assets WHERE id='a1'").fetchone()[0] == "http 404"
```

- [ ] **Step 2: Write the failing client-layer tests (HTTP method behavior)**

In `projects/common/tests/test_d1_client.py`, replace `test_assets_needing_rehost_maps` and `test_increment_rehost_attempts` with, and add `test_mark_asset_dead_binds`:

```python
def _rehost_row(id):
    return {"id": id, "prompt": "p", "source": "pd12m", "source_id": "7",
            "model_used": None, "content_hash": None, "width": 1, "height": 2,
            "mime": "image/jpeg", "source_url": "https://ext/x.jpg", "locally_cached": 0}

def test_assets_needing_rehost_demand_then_trickle(monkeypatch):
    c, calls = _client(monkeypatch, [[_rehost_row("hot")], [_rehost_row("cold")]])
    out = c.assets_needing_rehost(2)
    assert [a.id for a in out] == ["hot", "cold"]
    sql1, params1 = calls[0]
    assert "ORDER BY q.demand DESC" in sql1 and "live_assets" in sql1 and params1 == [2]
    sql2, params2 = calls[1]
    assert "NOT IN (?)" in sql2 and "live_assets" in sql2 and params2 == ["hot", 1]

def test_assets_needing_rehost_skips_trickle_when_demand_fills_batch(monkeypatch):
    c, calls = _client(monkeypatch, [[_rehost_row("h1"), _rehost_row("h2")]])
    out = c.assets_needing_rehost(2)
    assert [a.id for a in out] == ["h1", "h2"]
    assert len(calls) == 1                      # no trickle query issued

def test_increment_rehost_attempts_returns_new_count(monkeypatch):
    c, calls = _client(monkeypatch, [[{"rehost_attempts": 3}]])
    assert c.increment_rehost_attempts("i1") == 3
    sql, params = calls[0]
    assert "RETURNING rehost_attempts" in sql and params == ["i1"]

def test_increment_rehost_attempts_missing_row_returns_zero(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    assert c.increment_rehost_attempts("ghost") == 0

def test_mark_asset_dead_binds(monkeypatch):
    c, calls = _client(monkeypatch, [[]])
    c.mark_asset_dead("a1", "http 404")
    sql, params = calls[0]
    assert "dead_at=datetime('now')" in sql and "dead_at IS NULL" in sql
    assert params == ["http 404", "a1"]
```

- [ ] **Step 3: Run tests to verify they fail**

Run (repo root): `uv run pytest projects/common/tests/test_d1_migration.py projects/common/tests/test_d1_client.py -q`
Expected: FAIL with `AttributeError` on `trickle_rehosts_sql` / `DEMANDED_REHOSTS_SQL` / `MARK_ASSET_DEAD_SQL` / `mark_asset_dead`.

- [ ] **Step 4: Implement in `d1_client.py`**

Replace the `ASSET_EXISTS_SQL`, `ASSETS_NEEDING_REHOST_SQL`, and `INCREMENT_REHOST_ATTEMPTS_SQL` constants (lines ~55-63) with:

```python
ASSET_EXISTS_SQL = "SELECT 1 FROM live_assets WHERE id=? LIMIT 1"

_REHOST_COLS = ("id, prompt, source, source_id, model_used, content_hash, width, height, "
                "mime, source_url, locally_cached")

# Demand-ranked rehost selection: start from the queries aggregate (one row per
# unique prompt — small), join into live assets; never scans the assets table.
DEMANDED_REHOSTS_SQL = (
    "SELECT " + ", ".join(f"a.{c.strip()}" for c in _REHOST_COLS.split(",")) + " FROM ("
    "SELECT last_asset_id AS id, SUM(count) AS demand FROM queries "
    "WHERE last_asset_id IS NOT NULL GROUP BY last_asset_id) q "
    "JOIN live_assets a ON a.id = q.id "
    f"WHERE a.locally_cached=0 AND a.rehost_attempts < {MAX_REHOST_ATTEMPTS} "
    "ORDER BY q.demand DESC LIMIT ?")


def trickle_rehosts_sql(n_exclude: int) -> str:
    """FIFO fallback for leftover batch slots; excludes already-picked ids."""
    exclude = f" AND id NOT IN ({','.join('?' * n_exclude)})" if n_exclude else ""
    return (f"SELECT {_REHOST_COLS} FROM live_assets "
            f"WHERE locally_cached=0 AND rehost_attempts < {MAX_REHOST_ATTEMPTS}"
            f"{exclude} LIMIT ?")


INCREMENT_REHOST_ATTEMPTS_SQL = (
    "UPDATE assets SET rehost_attempts=rehost_attempts+1 WHERE id=? "
    "RETURNING rehost_attempts")

MARK_ASSET_DEAD_SQL = (
    "UPDATE assets SET dead_at=datetime('now'), dead_reason=? "
    "WHERE id=? AND dead_at IS NULL")
```

Replace the three methods (`assets_needing_rehost`, `increment_rehost_attempts`) and add `mark_asset_dead`:

```python
    def assets_needing_rehost(self, limit: int) -> list[AssetRecord]:
        rows = self._query(DEMANDED_REHOSTS_SQL, [limit])
        if len(rows) < limit:
            picked = [r["id"] for r in rows]
            rows += self._query(trickle_rehosts_sql(len(picked)),
                                [*picked, limit - len(rows)])
        return [AssetRecord(
            id=r["id"], prompt=r["prompt"], model_used=r["model_used"], source=r["source"],
            source_id=r["source_id"], content_hash=r["content_hash"], width=r["width"],
            height=r["height"], mime=r["mime"], created_at="",
            source_url=r["source_url"], locally_cached=bool(r["locally_cached"])) for r in rows]

    def increment_rehost_attempts(self, asset_id: str) -> int:
        """Returns the post-increment attempt count (0 if the row is missing)."""
        rows = self._query(INCREMENT_REHOST_ATTEMPTS_SQL, [asset_id])
        return int(rows[0]["rehost_attempts"]) if rows else 0

    def mark_asset_dead(self, asset_id: str, reason: str) -> None:
        """Tombstone: idempotent, first reason wins (guarded by dead_at IS NULL)."""
        self._query(MARK_ASSET_DEAD_SQL, [reason, asset_id])
```

- [ ] **Step 5: Run tests to verify they pass, then the full Python suite**

Run (repo root): `uv run pytest projects/common/tests/test_d1_migration.py projects/common/tests/test_d1_client.py -q` → PASS.
Then: `uv run pytest -q`
Expected: FAIL is possible only in `projects/backfill/tests` if anything asserted the old `increment_rehost_attempts` return; the current fake returns `None` implicitly and nothing asserts it — expect PASS. If backfill tests fail here, stop and re-read; do not patch backfill in this task (Task 4 owns it).

- [ ] **Step 6: Commit**

```bash
git add projects/common/src/wagmiphotos/common/d1_client.py projects/common/tests/test_d1_migration.py projects/common/tests/test_d1_client.py
git commit -m "feat(d1): demand-ranked rehost selection + tombstone methods"
```

---

### Task 3: `VectorizeClient.delete(ids)`

**Files:**
- Modify: `projects/common/src/wagmiphotos/common/vectorize_client.py`
- Test: `projects/common/tests/test_vectorize_client.py`

**Interfaces:**
- Consumes: existing `shard_for(id, shards)` routing and `post_with_retry`.
- Produces: `VectorizeClient.delete(ids: list[str]) -> None` — groups ids by shard, POSTs JSON `{"ids": [...]}` to each shard's `/delete_by_ids`. Task 4's `FakeVectorize.delete` mirrors this signature.

- [ ] **Step 1: Write the failing tests**

Append to `projects/common/tests/test_vectorize_client.py` (uses the file's existing `_vectorize`/`_ok` helpers; the fake records `(url, kwargs)` tuples in `fake.calls`):

```python
def test_delete_posts_ids_to_the_routed_shard(monkeypatch):
    v, fake = _vectorize(monkeypatch, [_ok()])
    v.delete(["a1"])
    url, kw = fake.calls[0]
    assert url.endswith("/wagmiphotos-bge-0/delete_by_ids")
    assert kw["json"] == {"ids": ["a1"]}

def test_delete_groups_ids_by_shard(monkeypatch):
    from wagmiphotos.common.shard import shard_for
    v, fake = _vectorize(monkeypatch, [_ok(), _ok(), _ok()], shards=3)
    ids = ["demo-1", "demo-3", "pd12m-8492731"]   # contract fixtures: shards 0, 1, 2
    v.delete(ids)
    assert len(fake.calls) == 3
    for url, kw in fake.calls:
        shard = int(url.split("wagmiphotos-bge-")[1].split("/")[0])
        assert all(shard_for(i, 3) == shard for i in kw["json"]["ids"])

def test_delete_empty_is_a_noop(monkeypatch):
    v, fake = _vectorize(monkeypatch, [])
    v.delete([])
    assert fake.calls == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run (repo root): `uv run pytest projects/common/tests/test_vectorize_client.py -q`
Expected: FAIL with `AttributeError: 'VectorizeClient' object has no attribute 'delete'`.

- [ ] **Step 3: Implement**

Append to the `VectorizeClient` class in `vectorize_client.py`:

```python
    def delete(self, ids: list[str]) -> None:
        """Delete vectors by id, routed to each id's shard (best-effort cleanup
        for tombstoned assets — the Worker tolerates orphan vectors)."""
        by_shard: dict[int, list[str]] = {}
        for id in ids:
            by_shard.setdefault(shard_for(id, self._shards), []).append(id)
        for shard in sorted(by_shard):
            post_with_retry(self._client, f"{self._index_base(shard)}/delete_by_ids",
                            what="Vectorize delete_by_ids", headers=self._headers(),
                            json={"ids": by_shard[shard]})
```

- [ ] **Step 4: Run tests to verify they pass**

Run (repo root): `uv run pytest projects/common/tests/test_vectorize_client.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/common/src/wagmiphotos/common/vectorize_client.py projects/common/tests/test_vectorize_client.py
git commit -m "feat(vectorize): delete(ids) routed by shard"
```

---

### Task 4: Tombstoning in the backfill rehost pass

**Files:**
- Modify: `projects/backfill/src/wagmiphotos/backfill/worker.py` (imports, `_download_capped`, `rehost_pass`; add `SourceGone` and `_tombstone`)
- Modify: `projects/backfill/tests/fakes.py` (`FakeD1`, `FakeVectorize`)
- Test: `projects/backfill/tests/test_backfill.py`

**Interfaces:**
- Consumes: `D1Client.mark_asset_dead(asset_id, reason)`, `D1Client.increment_rehost_attempts(asset_id) -> int`, `MAX_REHOST_ATTEMPTS` (Task 2); `VectorizeClient.delete(ids)` (Task 3).
- Produces: `SourceGone` exception (module level in `worker.py`); tombstone behavior relied on by ops, no downstream code consumers.

- [ ] **Step 1: Update the fakes**

In `projects/backfill/tests/fakes.py`, inside `FakeD1.__init__` add:

```python
        self.dead: dict[str, str] = {}
```

Replace `FakeD1.asset_exists`, `assets_needing_rehost`, and `increment_rehost_attempts`, and add `mark_asset_dead`:

```python
    def asset_exists(self, asset_id):
        return asset_id in self.assets and asset_id not in self.dead

    def assets_needing_rehost(self, limit):
        out = [a for a in self.rehost
               if self.rehost_attempts.get(a.id, 0) < 5 and a.id not in self.dead]
        return out[:limit]

    def increment_rehost_attempts(self, asset_id):
        self.rehost_attempts[asset_id] = self.rehost_attempts.get(asset_id, 0) + 1
        return self.rehost_attempts[asset_id]

    def mark_asset_dead(self, asset_id, reason):
        self.dead.setdefault(asset_id, reason)      # idempotent, first reason wins
        self.rehost = [a for a in self.rehost if a.id != asset_id]
```

In `FakeVectorize.__init__` add `self.deleted: list[list[str]] = []`, and add the method:

```python
    def delete(self, ids):
        self.deleted.append(list(ids))
        for id in ids:
            self.vectors.pop(id, None)
```

- [ ] **Step 2: Write the failing tests**

First, update the existing `test_rehost_pass_failure_increments_attempts_and_logs` (~line 270): it currently simulates a generic failure with `status_code=404`, but after this task a 404 means tombstone, not retry. Change its patch line to a 500 and pin the no-tombstone behavior:

```python
    _patch_httpx(monkeypatch, status_code=500, chunks=[])
```

and add at the end of that test:

```python
    assert d1.dead == {} and vec.deleted == []     # below budget: retry, don't tombstone
```

Then append the new tests (they use existing `_rehost_rec` — default id `"pd1"` — and `_patch_httpx(status_code=…)`):

```python
@pytest.mark.asyncio
async def test_rehost_pass_tombstones_on_404(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, status_code=404)
    done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 0
    assert d1.dead == {"pd1": "http 404"}
    assert d1.rehost_attempts == {}                # gone-signal spends no attempt
    assert vec.deleted == [["pd1"]]

@pytest.mark.asyncio
async def test_rehost_pass_tombstones_on_410(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    _patch_httpx(monkeypatch, status_code=410)
    await _worker(d1, vec, batch_size=5).rehost_pass()
    assert d1.dead == {"pd1": "http 410"}

@pytest.mark.asyncio
async def test_rehost_pass_tombstones_after_exhausted_retries(monkeypatch):
    d1, vec = FakeD1(), FakeVectorize()
    d1.rehost = [_rehost_rec()]
    d1.rehost_attempts["pd1"] = 4                   # one failure away from the budget
    _patch_httpx(monkeypatch, status_code=500)
    done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 0
    assert d1.rehost_attempts["pd1"] == 5
    assert d1.dead == {"pd1": "retries exhausted"}
    assert vec.deleted == [["pd1"]]

@pytest.mark.asyncio
async def test_vector_delete_failure_keeps_asset_dead_and_pass_alive(monkeypatch, caplog):
    class ExplodingVec(FakeVectorize):
        def delete(self, ids):
            raise RuntimeError("vectorize down")
    d1, vec = FakeD1(), ExplodingVec()
    d1.rehost = [_rehost_rec(), _rehost_rec("pd2")]
    _patch_httpx(monkeypatch, status_code=404)
    with caplog.at_level(logging.ERROR):
        done = await _worker(d1, vec, batch_size=5).rehost_pass()
    assert done == 0
    assert set(d1.dead) == {"pd1", "pd2"}           # D1-first: death sticks
    assert "vector delete failed" in caplog.text
```

- [ ] **Step 3: Run tests to verify they fail**

Run (repo root): `uv run pytest projects/backfill/tests/test_backfill.py -q`
Expected: the four new tests FAIL (`d1.dead` stays empty — 404/500 currently take the generic increment path); the updated failure test and all other existing tests pass (a 500 hits the same generic path a 404 used to).

- [ ] **Step 4: Implement in `worker.py`**

Change the d1_client import (line ~6) to also bring the budget constant:

```python
from wagmiphotos.common.d1_client import MAX_REHOST_ATTEMPTS, QueryRow
```

Add after the module constants (near `_MAX_ERROR_CHARS`):

```python
class SourceGone(Exception):
    """The rehost source returned a definitive gone-signal (HTTP 404/410)."""
```

In `_download_capped`, replace the status check:

```python
            if resp.status_code in (404, 410):
                raise SourceGone(f"http {resp.status_code}")
            if resp.status_code != 200:
                raise RuntimeError(f"download {resp.status_code}")
```

Replace the `try/except` body of the per-record loop in `rehost_pass` with:

```python
                try:
                    orig = await self._download_capped(client, rec.source_url)
                    sizes = derive_sizes(orig)
                    w, h = dimensions(sizes["large"])
                    self._storage.put(asset_key("large", rec.id), sizes["large"], "image/webp")
                    self._storage.put(asset_key("medium", rec.id), sizes["medium"], "image/webp")
                    self._storage.put(asset_key("thumb", rec.id), sizes["thumb"], "image/webp")
                    self._d1.mark_asset_rehosted(rec.id, width=w, height=h, mime="image/webp")
                    done += 1
                except SourceGone as e:
                    # Definitive gone-signal: tombstone now, spend no retry budget.
                    logger.warning("source gone for asset %s (%s)", rec.id, e)
                    self._tombstone(rec.id, str(e))
                except Exception:
                    logger.exception("rehost failed for asset %s", rec.id)
                    # Budgeted retries: a permanently failing source stops
                    # blocking the head of the rehost queue.
                    if self._d1.increment_rehost_attempts(rec.id) >= MAX_REHOST_ATTEMPTS:
                        self._tombstone(rec.id, "retries exhausted")
```

Add the helper method after `rehost_pass`:

```python
    def _tombstone(self, asset_id: str, reason: str) -> None:
        # D1 first: the asset stops being served/matched even if the vector
        # delete fails — the Worker match path skips orphan vectors.
        self._d1.mark_asset_dead(asset_id, reason)
        try:
            self._vec.delete([asset_id])
        except Exception:
            logger.exception("vector delete failed for dead asset %s", asset_id)
```

- [ ] **Step 5: Run tests to verify they pass, then the full Python suite**

Run (repo root): `uv run pytest projects/backfill/tests/test_backfill.py -q` → PASS.
Then: `uv run pytest -q` → PASS (expect 150+ after the additions).

- [ ] **Step 6: Commit**

```bash
git add projects/backfill/src/wagmiphotos/backfill/worker.py projects/backfill/tests/fakes.py projects/backfill/tests/test_backfill.py
git commit -m "feat(backfill): tombstone dead sources in the rehost pass"
```

---

### Task 5: Worker read paths switch to `live_assets`

**Files:**
- Modify: `projects/worker/src/d1.ts` (the three `assets` store queries, lines ~17-40)
- Test: `projects/worker/test/d1.test.ts`

**Interfaces:**
- Consumes: Task 1's `live_assets` view (must be applied to D1 before this Worker deploys — see Global Constraints).
- Produces: dead assets invisible to `getAsset` (match path + library download), `searchAssets` (browse/search), `getAssetsByIds` (semantic hydration). No type or API shape changes.

- [ ] **Step 1: Update the failing tests**

In `projects/worker/test/d1.test.ts`:

In `"getAsset selects by id and maps row"` change the FROM assertion (line ~29):

```ts
  expect(calls[0].sql).toContain("FROM live_assets");
```

In `"searchAssets browse mode: no WHERE, ordered newest-first, binds limit/offset"` add after the existing sql assertions (note: the browse SQL still contains no `WHERE` — the view hides the liveness filter, so the existing `.not.toContain("WHERE")` assertion stays):

```ts
  expect(calls[0].sql).toContain("FROM live_assets");
```

In `"searchAssets query mode: LIKE over prompt with bound pattern"` add:

```ts
  expect(calls[0].sql).toContain("FROM live_assets");
```

Find the `getAssetsByIds` test (search the file for `getAssetsByIds`) and add the same assertion to it:

```ts
  expect(calls[0].sql).toContain("FROM live_assets");
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `projects/worker`): `npm test -- test/d1.test.ts`
Expected: the four amended tests FAIL (`FROM assets` ≠ `FROM live_assets`).

- [ ] **Step 3: Implement in `d1.ts`**

Change the three queries in the `assets` store (only the table name changes):

```ts
    async getAsset(id) {
      const row = await db.prepare(`SELECT ${ASSET_COLS} FROM live_assets WHERE id = ?`).bind(id).first<AssetRow>();
      return row ?? null;
    },
```

In `searchAssets`, both branches:

```ts
      const stmt = tokens.length
        ? db.prepare(
            `SELECT ${ASSET_COLS}, created_at FROM live_assets WHERE ${tokens.map(() => "prompt LIKE ? ESCAPE '\\'").join(" AND ")} ${tail}`
          ).bind(...tokens.map((t) => `%${escapeLike(t)}%`), limit, offset)
        : db.prepare(`SELECT ${ASSET_COLS}, created_at FROM live_assets ${tail}`).bind(limit, offset);
```

In `getAssetsByIds`:

```ts
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at FROM live_assets WHERE id IN (${marks})`
      ).bind(...ids).all<LibraryAssetRow>();
```

Also update the comment above `ASSET_COLS` if none mentions the view; add one line:

```ts
// Reads select FROM live_assets (migration 0008): the view owns the
// dead_at IS NULL invariant, so dead assets are invisible to every read.
```

- [ ] **Step 4: Run the full worker suite**

Run (from `projects/worker`): `npm test`
Expected: PASS (157+). The handler/library tests pass unchanged because the fake stores in `test/fakes.ts` don't run SQL — liveness semantics are pinned by the SQL-string assertions in d1.test.ts and the real-schema tests in test_d1_migration.py.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/d1.ts projects/worker/test/d1.test.ts
git commit -m "feat(worker): read assets through the live_assets view"
```

---

### Final check

- [ ] Run both suites from a clean state:

```bash
uv run pytest -q                      # repo root
cd projects/worker && npm test        # worker
```

Expected: PASS everywhere. Deployment reminder: `wrangler d1 migrations apply wagmiphotos --remote` must run before the next Worker deploy and before the backfill runs with this code.
