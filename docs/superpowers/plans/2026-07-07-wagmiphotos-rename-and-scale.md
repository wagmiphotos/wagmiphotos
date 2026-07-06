# wagmiphotos Rename + PD12M Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every sharedcache identity to wagmiphotos and make the storage layer hold PD12M scale: 3 Vectorize shards (30M vectors), derived asset URLs (~3.7GB D1 savings), and semantic library search replacing the LIKE scan.

**Architecture:** Static hash-sharding (`fnv1a32(id) % 3`) across three Vectorize indexes with parallel query fan-out and score-merge; asset URLs become pure functions of `(id, locally_cached, source_url)` via path templates pinned in `contract.json`; `GET /v1/library?q=` reuses the BGE embed + shard fan-out with the LIKE scan demoted to an offline/dev fallback. Spec: `docs/superpowers/specs/2026-07-07-wagmiphotos-rename-and-scale-design.md`.

**Tech Stack:** Cloudflare Workers (TS, vitest, wrangler 4), Python 3.11 (uv workspace, pytest, httpx), D1/SQLite migrations, Vectorize REST + bindings.

## Global Constraints

- Cross-language constants live in `/contract.json`; every new constant added there needs a parity assertion in BOTH `projects/worker/test/contract.test.ts` and `projects/common/tests/test_contract.py`.
- FNV-1a 32-bit: offset basis `2166136261`, prime `16777619`, unsigned 32-bit wraparound, over UTF-8 bytes.
- Shards: exactly 3, indexes `wagmiphotos-bge-0|1|2`, 768 dims, cosine.
- Public API response shapes must NOT change (`data[0].url`, `shared_cache.sizes{thumb,medium,large}`, library `images[]` fields, `has_more`).
- Rename is behavior-neutral: after Tasks 2-4 both suites pass with only name-literal edits.
- The model-id prefix becomes `wagmiphotos-<provider>-<model>`; no backward compatibility for `shared-cache-*` ids.
- Test commands: `uv run pytest projects/ -q` (repo root) and `cd projects/worker && npm test && npx tsc --noEmit`.
- Commit after every task; never commit `.dev.vars` or `.wrangler/`.

---

### Task 0: Commit the pending audit fix sweep

The working tree holds the reviewed-and-verified 2026-07-07 fix sweep (~57 files + contract.json, migration 0006, `.dev.vars.example`, docs/archive moves). It must land as its own commit before rename churn.

**Files:** everything currently modified/untracked except `.dev.vars`, `.playwright-mcp/` (now gitignored).

- [ ] **Step 1: Verify both suites green**

Run: `uv run pytest projects/ -q` → `117 passed`; `cd projects/worker && npm test` → `135 passed`; `npx tsc --noEmit` → silent.

- [ ] **Step 2: Stage and commit**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git add -A
git status --short   # confirm: no .dev.vars, no .playwright-mcp/ entries staged
git commit -m "fix: audit sweep — fail-closed DEV_MODE, backfill reliability (0006), BGE docs, contract.json

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: Foundations — contract.json additions

**Files:**
- Modify: `contract.json`

**Interfaces:**
- Produces: contract keys `vectorize_index_prefix` (string), `vectorize_shards` (int), `shard_fixtures` (map id→shard), `asset_paths` (map size→template with `{id}`).

(Migration 0007 is created in Task 9 alongside its consumers, so both suites stay green through Tasks 2-8.)

- [ ] **Step 1: Add the new contract keys** (merge into the existing JSON object, keep existing keys):

```json
{
  "vectorize_index_prefix": "wagmiphotos-bge-",
  "vectorize_shards": 3,
  "shard_fixtures": {
    "demo-1": 0,
    "demo-2": 0,
    "demo-3": 1,
    "demo-4": 1,
    "0f7e2f6a-9d0e-4a3b-8c1d-2e5f6a7b8c9d": 1,
    "c0ffee00-cafe-4bad-a555-000000000001": 0,
    "pd12m-8492731": 2
  },
  "asset_paths": {
    "large": "assets/{id}/image.webp",
    "medium": "assets/{id}/medium.webp",
    "thumb": "assets/{id}/thumb.webp",
    "manifest": "assets/{id}/manifest.json"
  }
}
```

Also extend the `_comment` to mention shard routing (`fnv1a32(id) % vectorize_shards`) and that `shard_fixtures` pins the hash on both sides.

- [ ] **Step 2: Verify suites untouched** — `uv run pytest projects/ -q` → 117 passed; `cd projects/worker && npm test` → 135 passed (contract tests only assert existing keys).

- [ ] **Step 3: Commit**

```bash
git add contract.json
git commit -m "feat(contract): shard routing + asset-path keys"
```

---

### Task 2: Python package/dist rename (sharedcache.* → wagmiphotos.*)

Pure rename + the model-id prefix change. Python suite must end green.

**Files:**
- Move: `projects/{common,generation,backfill}/src/sharedcache` → `src/wagmiphotos`
- Modify: `projects/{common,generation,backfill}/pyproject.toml`, root `pyproject.toml`, `uv.lock` (regenerated), every `projects/**/*.py` import, `projects/generation/src/.../generator.py` (prefix), `projects/common/src/.../bge.py` (install hint)

**Interfaces:**
- Produces: import roots `wagmiphotos.common`, `wagmiphotos.generation`, `wagmiphotos.backfill`; console script `wagmiphotos-backfill`; `build_model_id(provider, model)` → `f"wagmiphotos-{provider}-{model}"`.

- [ ] **Step 1: Move the namespace dirs**

```bash
git mv projects/common/src/sharedcache projects/common/src/wagmiphotos
git mv projects/generation/src/sharedcache projects/generation/src/wagmiphotos
git mv projects/backfill/src/sharedcache projects/backfill/src/wagmiphotos
```

- [ ] **Step 2: Rewrite imports and name literals**

```bash
grep -rl 'sharedcache' projects/common projects/generation projects/backfill --include='*.py' --include='*.toml' \
  | xargs sed -i 's/sharedcache\./wagmiphotos./g; s/sharedcache-common/wagmiphotos-common/g; s/sharedcache-generation/wagmiphotos-generation/g; s/sharedcache-backfill/wagmiphotos-backfill/g; s|src/sharedcache|src/wagmiphotos|g'
grep -rn 'sharedcache' projects/common projects/generation projects/backfill --include='*.py' --include='*.toml'
```

Expected: zero hits. Manually verify each `pyproject.toml`: `name =`, `[project.scripts] wagmiphotos-backfill = "wagmiphotos.backfill.__main__:main"`, `[tool.hatch.build.targets.wheel] packages = ["src/wagmiphotos"]`, and inter-project dependencies/`tool.uv.sources` keys. Root `pyproject.toml`: `name = "wagmiphotos"`.

- [ ] **Step 3: Model-id prefix.** In `projects/generation/src/wagmiphotos/generation/generator.py`, change the prefix constant/literals used by `build_model_id`/`parse_model_id` from `shared-cache` to `wagmiphotos`; update their tests in `projects/generation/tests/test_generator.py` to expect `wagmiphotos-gmicloud-gpt-image-1`. In `bge.py`, the ImportError hint becomes `pip install 'wagmiphotos-backfill[model]'`.

- [ ] **Step 4: Relock and test**

```bash
uv lock && uv sync
uv run pytest projects/ -q
```

Expected: `117 passed`. Also `uv run wagmiphotos-backfill --help` exits 0 (or prints usage).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor: rename Python namespace/dists sharedcache→wagmiphotos, model prefix wagmiphotos-*"`

---

### Task 3: Worker + D1 + local-recipe rename

**Files:**
- Modify: `projects/worker/wrangler.toml` (name, database_name), `projects/worker/package.json` + `package-lock.json` (name), `.claude/skills/running-locally/SKILL.md` (commands), `.claude/skills/running-locally/seed-demo.sql` (comment only — schema edits come in Task 10)

- [ ] **Step 1:** `wrangler.toml`: `name = "wagmiphotos-worker"`, `database_name = "wagmiphotos"`. `package.json`: `"name": "wagmiphotos-worker"` then `npm install` to sync the lockfile name.
- [ ] **Step 2:** Replace `sharedcache` in the skill's wrangler commands (`d1 migrations apply wagmiphotos --local`, `d1 execute wagmiphotos --local …`).
- [ ] **Step 3: Re-provision local D1 under the new name and verify**

```bash
cd projects/worker
npx wrangler d1 migrations apply wagmiphotos --local
npx wrangler d1 execute wagmiphotos --local --file ../../.claude/skills/running-locally/seed-demo.sql
```

Expected: migrations 0001→0006 apply to the fresh `wagmiphotos` local DB; the seed succeeds (0007 doesn't exist yet — Task 9 creates it; Task 10 rewrites this seed). Worker tests: `npm test` → `135 passed`; `npx tsc --noEmit` silent.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor: rename worker + D1 database to wagmiphotos"`

---

### Task 4: SPA localStorage key rename with legacy fallback

**Files:**
- Modify: `projects/worker/public/index.html` (stats/history load+save sites, currently keys `sharedcache_hits`, `sharedcache_saved`, `sharedcache_history` — locate with `grep -n "sharedcache_" projects/worker/public/index.html`)

**Interfaces:**
- Produces: keys `wagmiphotos_hits`, `wagmiphotos_saved`, `wagmiphotos_history`; helper `lsGet(name)` reading new key with one-time legacy fallback.

- [ ] **Step 1:** Add near the stats-load code:

```js
function lsGet(name) {
  // one-time legacy fallback: read old sharedcache_* keys, migrate, delete
  const v = localStorage.getItem('wagmiphotos_' + name);
  if (v !== null) return v;
  const old = localStorage.getItem('sharedcache_' + name);
  if (old !== null) {
    localStorage.setItem('wagmiphotos_' + name, old);
    localStorage.removeItem('sharedcache_' + name);
  }
  return old;
}
```

Replace every `localStorage.getItem('sharedcache_X')` with `lsGet('X')` and every `localStorage.setItem('sharedcache_X', …)` with `localStorage.setItem('wagmiphotos_X', …)`.

- [ ] **Step 2: Verify** — extract the script block and `node --check` it; `grep -c "sharedcache_" projects/worker/public/index.html` → exactly 2 (both inside `lsGet`).
- [ ] **Step 3: Commit** — `git add projects/worker/public/index.html && git commit -m "refactor(spa): wagmiphotos_* localStorage keys with legacy migration"`

---

### Task 5: TS shard module (fnv1a32 + contract fixtures)

**Files:**
- Create: `projects/worker/src/shard.ts`
- Test: `projects/worker/test/contract.test.ts` (extend)

**Interfaces:**
- Produces: `fnv1a32(s: string): number` (unsigned 32-bit), `shardFor(id: string, shards: number): number`.

- [ ] **Step 1: Failing test** — append to `test/contract.test.ts`:

```ts
import { fnv1a32, shardFor } from "../src/shard";

it("shard routing matches the contract fixtures", () => {
  for (const [id, shard] of Object.entries(contract.shard_fixtures)) {
    expect(shardFor(id, contract.vectorize_shards)).toBe(shard);
  }
});
it("fnv1a32 reference value", () => {
  expect(fnv1a32("demo-1")).toBe(207613968);
});
```

- [ ] **Step 2:** `npm test -- contract` → FAIL (module not found).
- [ ] **Step 3: Implement `src/shard.ts`**

```ts
// FNV-1a 32-bit over UTF-8 bytes (contract.json: shard_fixtures pins parity
// with the Python implementation in wagmiphotos.common.shard).
export function fnv1a32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5; // 2166136261
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0; // * 16777619, unsigned wraparound
  }
  return h >>> 0;
}

export function shardFor(id: string, shards: number): number {
  return fnv1a32(id) % shards;
}
```

- [ ] **Step 4:** `npm test -- contract` → PASS. **Step 5: Commit** `git add projects/worker/src/shard.ts projects/worker/test/contract.test.ts && git commit -m "feat(worker): fnv1a32 shard routing pinned to contract fixtures"`

---

### Task 6: Python shard module (fnv1a32 + contract fixtures)

**Files:**
- Create: `projects/common/src/wagmiphotos/common/shard.py`
- Test: `projects/common/tests/test_contract.py` (extend)

**Interfaces:**
- Produces: `fnv1a32(s: str) -> int`, `shard_for(id: str, shards: int) -> int`.

- [ ] **Step 1: Failing test** — append to `test_contract.py` (it already loads `contract.json` into `CONTRACT`):

```python
from wagmiphotos.common.shard import fnv1a32, shard_for

def test_shard_routing_matches_contract_fixtures():
    for asset_id, shard in CONTRACT["shard_fixtures"].items():
        assert shard_for(asset_id, CONTRACT["vectorize_shards"]) == shard

def test_fnv1a32_reference_value():
    assert fnv1a32("demo-1") == 207613968
```

- [ ] **Step 2:** `uv run pytest projects/common/tests/test_contract.py -q` → FAIL (ImportError).
- [ ] **Step 3: Implement `shard.py`**

```python
"""FNV-1a 32-bit over UTF-8 bytes. Parity with projects/worker/src/shard.ts
is pinned by contract.json shard_fixtures on both test suites."""

def fnv1a32(s: str) -> int:
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h

def shard_for(asset_id: str, shards: int) -> int:
    return fnv1a32(asset_id) % shards
```

- [ ] **Step 4:** test → PASS. **Step 5: Commit** `git commit -m "feat(common): fnv1a32 shard routing pinned to contract fixtures"` (add both files).

---

### Task 7: Worker 3-shard bindings + query fan-out

**Files:**
- Modify: `projects/worker/wrangler.toml`, `projects/worker/src/types.ts` (Env), `projects/worker/src/vectorize.ts`, `projects/worker/src/index.ts` (buildServices)
- Test: `projects/worker/test/vectorize.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: `makeVectorize(bindings: VectorizeIndex[]): VectorizeStore` (same `VectorizeStore.query(vector, topK)` interface — callers unchanged).

- [ ] **Step 1: Failing tests** — rewrite `test/vectorize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeVectorize } from "../src/vectorize";

const shard = (matches: { id: string; score: number }[]) =>
  ({ query: async (_v: number[], _o: any) => ({ matches }) }) as any;

describe("makeVectorize (sharded)", () => {
  it("fans out to every shard and merges by score desc", async () => {
    const store = makeVectorize([
      shard([{ id: "a", score: 0.91 }, { id: "b", score: 0.5 }]),
      shard([{ id: "c", score: 0.95 }]),
      shard([{ id: "d", score: 0.8 }]),
    ]);
    const out = await store.query([0.1], 3);
    expect(out.map((m) => m.id)).toEqual(["c", "a", "d"]);
  });
  it("dedupes ids keeping the higher score", async () => {
    const store = makeVectorize([shard([{ id: "a", score: 0.7 }]), shard([{ id: "a", score: 0.9 }])]);
    const out = await store.query([0.1], 5);
    expect(out).toEqual([{ id: "a", score: 0.9 }]);
  });
  it("tolerates a shard returning no matches field", async () => {
    const store = makeVectorize([({ query: async () => ({}) }) as any, shard([{ id: "x", score: 0.6 }])]);
    expect(await store.query([0.1], 2)).toEqual([{ id: "x", score: 0.6 }]);
  });
});
```

- [ ] **Step 2:** `npm test -- vectorize` → FAIL (array not accepted / merge missing).
- [ ] **Step 3: Implement `src/vectorize.ts`**

```ts
import type { VectorizeStore, Match } from "./types";

// One logical store over N shard indexes: queries fan out to every shard and
// merge by score (cosine scores from identically-configured indexes are
// directly comparable). Writes are routed by fnv1a32(id) — backfill-side only.
export function makeVectorize(bindings: VectorizeIndex[]): VectorizeStore {
  return {
    async query(vector, topK) {
      const results = await Promise.all(bindings.map((b) => b.query(vector, { topK })));
      const best = new Map<string, number>();
      for (const r of results) {
        for (const m of r.matches ?? []) {
          const prev = best.get(m.id);
          if (prev == null || m.score > prev) best.set(m.id, m.score);
        }
      }
      return [...best.entries()]
        .map(([id, score]): Match => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
}
```

- [ ] **Step 4:** `types.ts` Env: replace `VECTORIZE: VectorizeIndex` with `VECTORIZE_0: VectorizeIndex; VECTORIZE_1: VectorizeIndex; VECTORIZE_2: VectorizeIndex;`. `index.ts` buildServices: `makeVectorize([env.VECTORIZE_0, env.VECTORIZE_1, env.VECTORIZE_2])`. Update `test/fakes.ts`/router tests that construct the env (fake all three with the same stub).
- [ ] **Step 5:** `wrangler.toml`: replace the single `[[vectorize]]` block with three (`VECTORIZE_0`/`wagmiphotos-bge-0`, `VECTORIZE_1`/`wagmiphotos-bge-1`, `VECTORIZE_2`/`wagmiphotos-bge-2`).
- [ ] **Step 6:** `npm test` all green + `npx tsc --noEmit` + `npx wrangler deploy --dry-run` (three vectorize bindings accepted). **Commit** `"feat(worker): 3-shard Vectorize fan-out with score-merge"`.

---

### Task 8: Python VectorizeClient sharding + config

**Files:**
- Modify: `projects/common/src/wagmiphotos/common/vectorize_client.py`, `config.py`, `projects/backfill/src/wagmiphotos/backfill/worker.py` (`build_worker_from_settings` wiring), `projects/backfill/src/wagmiphotos/backfill/seed_pd12m.py` (client construction)
- Test: `projects/common/tests/test_vectorize_client.py`, `projects/common/tests/test_contract.py`

**Interfaces:**
- Produces: `VectorizeClient(account_id, index_prefix, shards, api_token, dims=768)` with `upsert(id, vector, metadata)` (routed by `shard_for`), `insert_many(items)` (grouped per shard, one REST call per non-empty shard), `query(vector, top_k)` (fan-out + merge desc + dedupe + slice). Config fields `vectorize_index_prefix: str = "wagmiphotos-bge-"`, `vectorize_shards: int = 3` (replacing `vectorize_index_name`).

- [ ] **Step 1: Failing tests** — in `test_vectorize_client.py` (follow its existing transport-mock pattern; the client records which index URL each request hit):

```python
def test_upsert_routes_by_fnv1a32(client_recording_requests):
    c, seen = client_recording_requests(shards=3)
    c.upsert("demo-1", [0.0] * 768, {})          # fnv1a32 % 3 == 0
    c.upsert("pd12m-8492731", [0.0] * 768, {})   # == 2
    assert "wagmiphotos-bge-0" in seen[0].url.path
    assert "wagmiphotos-bge-2" in seen[1].url.path

def test_insert_many_groups_per_shard(client_recording_requests):
    c, seen = client_recording_requests(shards=3)
    c.insert_many([("demo-1", [0.0] * 768, {}), ("demo-3", [0.0] * 768, {})])  # shards 0 and 1
    assert len(seen) == 2 and {p for p in ("bge-0", "bge-1") if any(p in r.url.path for r in seen)} == {"bge-0", "bge-1"}

def test_query_fans_out_and_merges(client_with_canned_matches):
    c = client_with_canned_matches({0: [("a", 0.91)], 1: [("c", 0.95)], 2: [("d", 0.80)]})
    out = c.query([0.0] * 768, top_k=2)
    assert [m["id"] for m in out] == ["c", "a"]
```

Also in `test_contract.py`: `assert Settings().vectorize_index_prefix == CONTRACT["vectorize_index_prefix"]` and `assert Settings().vectorize_shards == CONTRACT["vectorize_shards"]`.

- [ ] **Step 2:** run → FAIL. **Step 3: Implement** — keep the existing retry helper, dims validation, and `returnMetadata: "none"`; the shape of the change:

```python
from wagmiphotos.common.shard import shard_for

class VectorizeClient:
    def __init__(self, account_id, index_prefix, shards, api_token, dims=768):
        self._prefix, self._shards, self._dims = index_prefix, int(shards), dims
        # ... existing client/token/base-url setup ...

    def _index_path(self, shard: int) -> str:
        return f"indexes/{self._prefix}{shard}"

    def upsert(self, vec_id, vector, metadata):
        self._check_dims(vector)
        self._post(self._index_path(shard_for(vec_id, self._shards)) + "/upsert", [(vec_id, vector, metadata)])

    def insert_many(self, items):
        by_shard: dict[int, list] = {}
        for vec_id, vector, metadata in items:
            self._check_dims(vector)
            by_shard.setdefault(shard_for(vec_id, self._shards), []).append((vec_id, vector, metadata))
        for shard, batch in sorted(by_shard.items()):
            self._post(self._index_path(shard) + "/insert", batch)

    def query(self, vector, top_k):
        best: dict[str, float] = {}
        for shard in range(self._shards):
            for m in self._query_one(self._index_path(shard), vector, top_k):
                if m["id"] not in best or m["score"] > best[m["id"]]:
                    best[m["id"]] = m["score"]
        merged = sorted(({"id": i, "score": s} for i, s in best.items()),
                        key=lambda m: m["score"], reverse=True)
        return merged[:top_k]
```

(`_post`/`_query_one` are the existing REST helpers refactored to take the index path.)
- [ ] **Step 4:** update `config.py` (drop `vectorize_index_name`, add the two new fields), `build_worker_from_settings` and `seed_pd12m` to pass `(s.cf_account_id, s.vectorize_index_prefix, s.vectorize_shards, s.cf_api_token, dims=s.embedding_dims)`.
- [ ] **Step 5:** `uv run pytest projects/ -q` all green. **Commit** `"feat(backfill): shard-routed Vectorize writes + fan-out queries"`.

---

### Task 9: Migration 0007 + Python derived asset URLs

**Files:**
- Create: `projects/worker/migrations/0007_derived_urls.sql`, `projects/common/src/wagmiphotos/common/asset_paths.py`
- Modify: `projects/common/src/wagmiphotos/common/models.py` (AssetRecord), `d1_client.py` (`insert_asset`, `mark_asset_rehosted`, SELECT column lists), `projects/backfill/src/wagmiphotos/backfill/worker.py`, `seed_pd12m.py`
- Test: `projects/common/tests/test_contract.py`, `test_d1_migration.py`, `projects/backfill/tests/test_backfill.py`

- [ ] **Step 0: Write migration `0007_derived_urls.sql`** (this makes the worker's local DB ahead of its code until Task 10 — the TS suite uses fakes, so it stays green; only re-seeding needs Task 10's rewritten seed):

```sql
-- Asset URLs become derived: {ASSET_BASE_URL}/{asset_paths[size]} when
-- locally_cached=1, else source_url (contract.json: asset_paths). Dropping the
-- stored copies saves ~300B/row (~3.7GB at PD12M scale). No production data
-- exists; local data is re-seedable.
ALTER TABLE assets DROP COLUMN thumb_url;
ALTER TABLE assets DROP COLUMN medium_url;
ALTER TABLE assets DROP COLUMN url;
ALTER TABLE assets DROP COLUMN manifest_url;
```

**Interfaces:**
- Produces: `ASSET_PATHS: dict[str, str]` (keys `large|medium|thumb|manifest`, values with `{id}`) and `asset_key(size: str, asset_id: str) -> str`; `AssetRecord` WITHOUT `url/thumb_url/medium_url/manifest_url`; `D1Client.mark_asset_rehosted(asset_id, *, width, height, mime)`.

- [ ] **Step 1: Failing tests**

```python
# test_contract.py
from wagmiphotos.common.asset_paths import ASSET_PATHS, asset_key
def test_asset_paths_match_contract():
    assert ASSET_PATHS == CONTRACT["asset_paths"]
def test_asset_key_substitutes_id():
    assert asset_key("thumb", "abc") == "assets/abc/thumb.webp"
```

`test_d1_migration.py`: the all-migrations fixture now applies 0007; executing the (new, slimmed) `insert_asset` and `mark_asset_rehosted` SQL against the post-0007 schema must succeed, and executing the OLD insert (with `url`) must fail — delete that old string.

`test_backfill.py`: the generate-pass test asserts `storage.put` was called with keys `assets/{id}/image.webp|medium.webp|thumb.webp|manifest.json` built via `asset_key`, and that the inserted `AssetRecord` has no url fields; the rehost test asserts `mark_asset_rehosted` was called (fakes updated accordingly).

- [ ] **Step 2:** run → FAIL. **Step 3: Implement** — `asset_paths.py`:

```python
"""B2 object keys per asset. Parity with contract.json asset_paths (and the
worker's URL derivation) is pinned by test_contract; the backfill MUST write
to exactly these keys or derived URLs 404."""
ASSET_PATHS = {
    "large": "assets/{id}/image.webp",
    "medium": "assets/{id}/medium.webp",
    "thumb": "assets/{id}/thumb.webp",
    "manifest": "assets/{id}/manifest.json",
}

def asset_key(size: str, asset_id: str) -> str:
    return ASSET_PATHS[size].format(id=asset_id)
```

`worker.py` generate path: `self._storage.put(asset_key("large", asset_id), …)` etc.; the manifest still embeds the URLs **returned by** `storage.put` (they are the ground truth of where bytes landed). `AssetRecord` drops the four fields; `insert_asset` inserts `(id, prompt, source, source_id, content_hash, width, height, mime, source_url, locally_cached)`; `update_asset_urls` → `mark_asset_rehosted` (`UPDATE assets SET width=?, height=?, mime=?, locally_cached=1 WHERE id=?`); `rehost_pass` calls it; `seed_pd12m` builds slim records (`source_url=<hf url>`, `locally_cached=False`).

- [ ] **Step 4:** `uv run pytest projects/ -q` green. Apply 0007 locally: `cd projects/worker && npx wrangler d1 migrations apply wagmiphotos --local` → `0007_derived_urls.sql ✅`. **Commit** (include the migration file): `"feat(backfill): derived asset URLs — slim AssetRecord, contract-pinned B2 keys, migration 0007"`.

---

### Task 10: Worker derived asset URLs

**Files:**
- Create: `projects/worker/src/asset-urls.ts`
- Modify: `projects/worker/src/types.ts` (AssetRow, Env), `d1.ts` (ASSET_COLS), `handler.ts`, `library.ts`, `index.ts` (wire `ASSET_BASE_URL`), `wrangler.toml` ([vars] `ASSET_BASE_URL` placeholder comment), `.claude/skills/running-locally/seed-demo.sql`
- Test: `projects/worker/test/asset-urls.test.ts` (new), `handler.test.ts`, `library.test.ts`, `d1.test.ts`, `contract.test.ts`

**Interfaces:**
- Consumes: `contract.asset_paths` (Task 1). Produces: `assetUrls(a: { id: string; source_url: string | null; locally_cached: number }, baseUrl: string | undefined): { url: string; thumb_url: string | null; medium_url: string | null }`; `AssetRow` without `thumb_url/medium_url/url`; `GenCfg`/library cfg gain `assetBaseUrl?: string`.

- [ ] **Step 1: Failing tests** — `test/asset-urls.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assetUrls } from "../src/asset-urls";
import contract from "../../../contract.json";

const BASE = "https://cdn.example.com";

describe("assetUrls", () => {
  it("derives all sizes from the contract templates when locally cached", () => {
    const u = assetUrls({ id: "abc", source_url: null, locally_cached: 1 }, BASE);
    expect(u).toEqual({
      url: `${BASE}/assets/abc/image.webp`,
      thumb_url: `${BASE}/assets/abc/thumb.webp`,
      medium_url: `${BASE}/assets/abc/medium.webp`,
    });
    expect(u.url.endsWith(contract.asset_paths.large.replace("{id}", "abc"))).toBe(true);
  });
  it("serves source_url with null sizes when not locally cached", () => {
    expect(assetUrls({ id: "x", source_url: "https://o.example/p.png", locally_cached: 0 }, BASE))
      .toEqual({ url: "https://o.example/p.png", thumb_url: null, medium_url: null });
  });
  it("falls back to source_url when the base is unset (misconfiguration)", () => {
    expect(assetUrls({ id: "x", source_url: "https://o.example/p.png", locally_cached: 1 }, undefined).url)
      .toBe("https://o.example/p.png");
  });
  it("tolerates a trailing slash on the base", () => {
    expect(assetUrls({ id: "a", source_url: null, locally_cached: 1 }, BASE + "/").url)
      .toBe(`${BASE}/assets/a/image.webp`);
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement `src/asset-urls.ts`**

```ts
import contract from "../../../contract.json";

export interface AssetUrlInput { id: string; source_url: string | null; locally_cached: number; }
export interface DerivedUrls { url: string; thumb_url: string | null; medium_url: string | null; }

const fill = (tpl: string, id: string) => tpl.replace("{id}", id);

// URLs are pure functions of the row (spec Part 3). locally_cached rows live
// at the contract-pinned B2 keys under ASSET_BASE_URL; everything else serves
// its origin. An unset base on a cached row is a misconfiguration — degrade
// to the origin rather than emitting broken links.
export function assetUrls(a: AssetUrlInput, baseUrl: string | undefined): DerivedUrls {
  if (!a.locally_cached || !baseUrl) {
    if (a.locally_cached && !baseUrl) console.warn("ASSET_BASE_URL unset; serving source_url for", a.id);
    return { url: a.source_url ?? "", thumb_url: null, medium_url: null };
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/${fill(contract.asset_paths.large, a.id)}`,
    thumb_url: `${base}/${fill(contract.asset_paths.thumb, a.id)}`,
    medium_url: `${base}/${fill(contract.asset_paths.medium, a.id)}`,
  };
}
```

- [ ] **Step 4: Rewire consumers.** `types.ts`: drop `thumb_url/medium_url/url` from `AssetRow`; add `ASSET_BASE_URL?: string` to Env. `d1.ts` ASSET_COLS drops those columns. `handler.ts`: `GenCfg` gains `assetBaseUrl?: string`; build `const u = assetUrls(asset, cfg.assetBaseUrl)` and use `u.url` / `sizes: { thumb: u.thumb_url, medium: u.medium_url, large: u.url }` (response shape unchanged). `library.ts`: `publicAsset(r, baseUrl)` derives the three URL fields; `handleLibraryDownload` fetches `assetUrls(asset, cfg.assetBaseUrl).url`. `index.ts`: pass `assetBaseUrl: env.ASSET_BASE_URL` into both cfgs. Update the fake rows in `test/fakes.ts`/`d1.test.ts`/`handler.test.ts`/`library.test.ts` (rows now carry `source_url`+`locally_cached` instead of stored URLs) and assert derived output.
- [ ] **Step 5: Rewrite `seed-demo.sql`** — same four demo rows, now:

```sql
INSERT OR REPLACE INTO assets
  (id, prompt, source, source_url, model_used, width, height, mime, locally_cached)
VALUES
  ('demo-1', 'A flamingo standing in shallow water at sunset', 'pd12m',
   'http://127.0.0.1:8787/assets/match-flamingo.webp', NULL, 1024, 1024, 'image/webp', 0),
  ('demo-2', 'A cat and a dog sitting together on a couch', 'pd12m',
   'http://127.0.0.1:8787/assets/match-cat-dog.webp', NULL, 1024, 1024, 'image/webp', 0),
  ('demo-3', 'Grandpa giving an enthusiastic thumbs up', 'pd12m',
   'http://127.0.0.1:8787/assets/grandpa-thumbs-up.webp', NULL, 1024, 1024, 'image/webp', 0),
  ('demo-4', 'Two hands clasped in a firm handshake', 'pd12m',
   'http://127.0.0.1:8787/assets/handshake.webp', NULL, 1024, 1024, 'image/webp', 0);
```

(Keep the header comment; `locally_cached=0` → the SPA's `thumb_url || medium_url || url` fallback renders the grid from `url = source_url`.)

- [ ] **Step 6:** `npm test` + `npx tsc --noEmit` green; re-seed locally (`npx wrangler d1 execute wagmiphotos --local --file …seed-demo.sql`) succeeds. **Commit** `"feat(worker): derive asset URLs from contract paths (0007), ASSET_BASE_URL"`.

---

### Task 11: Semantic library search with LIKE fallback

**Files:**
- Modify: `projects/worker/src/library.ts`, `src/d1.ts` (+`getAssetsByIds`), `src/types.ts` (AssetStore), `src/index.ts` (pass cfg)
- Test: `projects/worker/test/library.test.ts`, `test/d1.test.ts`

**Interfaces:**
- Consumes: `Services.embedder.textEmbed`, `Services.vectorize.query` (Task 7), `assetUrls` (Task 10). Produces: `handleLibrarySearch(url: URL, s: Services, cfg: { floorSimMin: number; assetBaseUrl?: string })`; `AssetStore.getAssetsByIds(ids: string[]): Promise<LibraryAssetRow[]>`; `SEARCH_TOP_K = 100`.

- [ ] **Step 1: Failing tests** — key cases for `library.test.ts` (build on its existing fakes):

```ts
it("semantic search: embeds q, merges shards, floors at floorSimMin, orders by similarity", async () => {
  // embedder returns a fixed vector; fake vectorize returns
  // [{id:'b',score:0.95},{id:'a',score:0.80},{id:'junk',score:0.60}]; floor 0.72
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat"), services, { floorSimMin: 0.72 });
  const body = await res.json();
  expect(body.images.map((i: any) => i.id)).toEqual(["b", "a"]); // junk floored out
});
it("semantic search: offset/limit slice the merged window and set has_more", async () => {
  // 3 relevant matches, limit=1&offset=1 -> the middle one, has_more true
});
it("semantic search: ids missing from D1 are skipped (orphan vectors)", async () => {});
it("falls back to LIKE search when the embedder throws", async () => {
  // embedder.textEmbed = () => { throw new Error("no AI binding") }
  // expect the LIKE fake to receive the query and the response to be 200
});
it("empty q keeps the recency browse (vectorize never called)", async () => {});
```

`d1.test.ts`: `getAssetsByIds([])` → `[]` without querying; `getAssetsByIds(["demo-2","demo-1"])` returns both rows (any order).

- [ ] **Step 2:** FAIL. **Step 3: Implement** — `d1.ts`:

```ts
async getAssetsByIds(ids) {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT ${ASSET_COLS}, created_at FROM assets WHERE id IN (${marks})`
  ).bind(...ids).all<LibraryAssetRow>();
  return results ?? [];
}
```

`library.ts` — inside `handleLibrarySearch` after the existing q/limit/offset validation:

```ts
export const SEARCH_TOP_K = 100; // Vectorize topK cap without values/metadata

if (q) {
  try {
    const vec = await s.embedder.textEmbed(q);
    const matches = await s.vectorize.query(vec, SEARCH_TOP_K);
    const relevant = matches.filter((m) => m.score >= cfg.floorSimMin);
    const page = relevant.slice(offset, offset + limit);
    const rows = await s.assets.getAssetsByIds(page.map((m) => m.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const images = page.flatMap((m) => {
      const r = byId.get(m.id);
      return r ? [publicAsset(r, cfg.assetBaseUrl)] : []; // orphan vector: skip
    });
    return Response.json({ images, has_more: relevant.length > offset + limit });
  } catch (e) {
    // Workers AI / Vectorize unavailable (offline dev) or transient failure:
    // degrade to the LIKE scan rather than 500ing the library page.
    console.warn("semantic library search failed; falling back to LIKE", e);
  }
}
// browse (empty q) and fallback path: existing searchAssets LIKE + recency code
```

`index.ts` passes `{ floorSimMin: numEnv(env.FLOOR_SIM_MIN, FLOOR_SIM_MIN), assetBaseUrl: env.ASSET_BASE_URL }`.

- [ ] **Step 4:** `npm test` + `npx tsc --noEmit` green. **Step 5:** if the SPA docs page describes library search as substring/keyword matching, update that copy to "semantic search over the prompt library" (`grep -n "search" projects/worker/public/index.html` around the docs/library sections). **Commit** `"feat(worker): semantic library search via BGE + shards, LIKE demoted to fallback"`.

---

### Task 12: Docs, deploy runbook, env examples

**Files:**
- Modify: `DEPLOY.md`, `README.md`, `TODO.md`, `HANDOFF.md`, `.env.example`, `.claude/skills/running-locally/SKILL.md`

- [ ] **Step 1: DEPLOY.md** — provisioning becomes: `npx wrangler d1 create wagmiphotos`; three index creates:

```bash
for i in 0 1 2; do
  npx wrangler vectorize create "wagmiphotos-bge-$i" --dimensions=768 --metric=cosine
done
```

Add `ASSET_BASE_URL` to the vars section (B2 friendly-URL base, same value as the backfill's `B2_PUBLIC_URL_BASE`; without it cached assets degrade to `source_url`). Note: if a single `wagmiphotos-bge` index was ever created, delete it (`npx wrangler vectorize delete wagmiphotos-bge`) — it is superseded by the shards. Worker deploy name is now `wagmiphotos-worker`; any previously deployed `sharedcache-worker` would be orphaned, not upgraded.

- [ ] **Step 2: README/TODO/HANDOFF** — replace remaining `sharedcache` name references (D1 name, worker name, package names, `uv run wagmiphotos-backfill`); TODO's "sharedcache→wagmiphotos rename" item → done; add one line to README's search description: library search is semantic (BGE), LIKE only as fallback.
- [ ] **Step 3: `.env.example`** — `VECTORIZE_INDEX_NAME` → `VECTORIZE_INDEX_PREFIX=wagmiphotos-bge-` + `VECTORIZE_SHARDS=3`; DB name comment → `wagmiphotos`.
- [ ] **Step 4: SKILL.md** — already renamed commands in Task 3; add: library search offline exercises the LIKE fallback (a `console.warn` in the wrangler log is expected, not a bug).
- [ ] **Step 5:** grep gate for docs: `grep -rn "sharedcache" README.md DEPLOY.md TODO.md HANDOFF.md .env.example .claude/skills/` → zero hits. **Commit** `"docs: wagmiphotos names, 3-shard provisioning, ASSET_BASE_URL"`.

---

### Task 13: End-to-end verification + final gates

**Files:** none (verification only; fix regressions where found).

- [ ] **Step 1: Full suites** — `uv run pytest projects/ -q` and `cd projects/worker && npm test && npx tsc --noEmit && npx wrangler deploy --dry-run` — all green.
- [ ] **Step 2: Grep gates**

```bash
grep -rni "sharedcache\|shared-cache" projects/ contract.json README.md DEPLOY.md TODO.md HANDOFF.md .env.example .claude/skills/ \
  --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.wrangler
```

Expected: hits ONLY inside `lsGet`'s legacy-fallback lines in `projects/worker/public/index.html` (2 lines). Anything else is a missed rename.

- [ ] **Step 3: Boot smoke test** (running-locally skill, DB name `wagmiphotos`): migrate + seed + `wrangler dev --local`; verify `/healthz`; dev login → verify → `/v1/me` → keygen; `GET /v1/library?limit=4` renders 4 demo rows with `url` = the bundled asset (derived-URL fallback path); `GET /v1/library?q=flamingo` returns results via the LIKE fallback (expect the `semantic library search failed` warn in the dev log — offline-correct); generation POST → 500 `{"error":"internal error"}`.
- [ ] **Step 4: Commit any verification fixes**, then update project memory files (bge-embeddings: 3 shards + prefix; running-locally: DB name wagmiphotos; audit note) — memory lives outside the repo; the executing agent should report this step for the coordinator to do if it lacks access.

---

## Execution notes

- Tasks 2-4 are the rename (behavior-neutral); Tasks 5-6 are independent of each other; Task 7 depends on 5; Task 8 depends on 6 (and 2); Tasks 9-10 depend on 1 (and the rename); Task 11 depends on 7+10. Docs (12) last before verification (13).
- Both suites stay green at every task boundary. Within Task 9, the local D1 schema (0007 applied) runs ahead of the worker code until Task 10 lands — the TS suite uses fakes and is unaffected; just don't re-seed between 9 and 10.
- If `wrangler d1 migrations apply` complains the local `sharedcache` DB is gone after Task 3's rename, that's expected: the new name gets a fresh local DB; re-apply + re-seed.


