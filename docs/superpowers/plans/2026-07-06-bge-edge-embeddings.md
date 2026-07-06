# BGE Edge Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CLIP cross-modal embeddings with BGE `bge-base-en-v1.5` text-to-text embeddings — the Worker embeds query prompts via Cloudflare Workers AI at the edge, the GMI backfill embeds asset prompts with a local copy of the same model.

**Architecture:** Search path (Worker/TS) calls `env.AI.run('@cf/baai/bge-base-en-v1.5', …)`; index path (backfill/Python) runs `BAAI/bge-base-en-v1.5` locally. Both implement one shared contract (raw text, no prefix, CLS pooling, L2-normalized, 768-dim). The Worker only queries Vectorize; the backfill writes it. Greenfield — nothing is deployed, so provisioning is a clean first-time setup, no cutover.

**Tech Stack:** TypeScript + Cloudflare Workers AI + Vectorize + Vitest (Worker); Python + sentence-transformers + pytest (backfill).

## Global Constraints

- Embedding model: `bge-base-en-v1.5` — Workers AI `@cf/baai/bge-base-en-v1.5`, local `BAAI/bge-base-en-v1.5`. 768-dim.
- Embedding contract (both runtimes, verbatim): raw prompt/caption text, **NO instruction prefix** (symmetric similarity), CLS pooling, **L2-normalized** output, cosine distance.
- New Vectorize index name: `wagmiphotos-bge` (768-dim, cosine). Use the `wagmiphotos` name only for NEW artifacts; do NOT rename existing `sharedcache` resources/packages (separate task).
- Floor placeholders (both sides): `FLOOR_SIM_MAX = 0.90`, `FLOOR_SIM_MIN = 0.72` — starting points to live-tune, NOT final.
- The Worker `clip` service is renamed to `embedder` (the name "clip" is now wrong).
- `EMBEDDING_DIMS` stays 768.
- No change to generation, B2 storage, auth, or the SPA.

---

### Task 1: Worker — BGE embed + `clip`→`embedder` rename

**Files:**
- Modify: `projects/worker/src/embed.ts`
- Modify: `projects/worker/src/types.ts`
- Modify: `projects/worker/src/handler.ts`
- Modify: `projects/worker/src/index.ts`
- Modify: `projects/worker/test/fakes.ts`
- Test: `projects/worker/test/embed.test.ts`

**Interfaces:**
- Produces:
  - `bgeTextEmbed(prompt: string, env: Env): Promise<number[]>` (768-dim, L2-normalized)
  - `Embedder { textEmbed(prompt: string): Promise<number[]> }`, `Services.embedder`
  - `Env.AI` (Workers AI binding); `Env` no longer has `CLIP_TEXT_EMBED_URL`/`CLIP_EMBED_TOKEN`.

- [ ] **Step 1: Rewrite `test/embed.test.ts` (RED)**

Replace the whole file:
```ts
import { it, expect, vi } from "vitest";
import { bgeTextEmbed } from "../src/embed";

function fakeEnv(vec: number[]) {
  return { AI: { run: vi.fn(async () => ({ shape: [1, vec.length], data: [vec] })) } } as any;
}

it("bgeTextEmbed calls the bge model and returns the vector", async () => {
  const env = fakeEnv([3, 4]); // un-normalized on purpose
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const v = await bgeTextEmbed("a red fox", env);
  expect(env.AI.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: "a red fox" });
  expect(fetchSpy).not.toHaveBeenCalled();          // no external embed call
  // L2-normalized: [3,4] -> [0.6, 0.8]
  expect(v[0]).toBeCloseTo(0.6, 5);
  expect(v[1]).toBeCloseTo(0.8, 5);
  vi.unstubAllGlobals();
});

it("bgeTextEmbed throws on an unexpected response", async () => {
  const env = { AI: { run: async () => ({ data: null }) } } as any;
  await expect(bgeTextEmbed("x", env)).rejects.toThrow(/Unexpected/);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd projects/worker && npx vitest run test/embed.test.ts`
Expected: FAIL (`bgeTextEmbed` not exported).

- [ ] **Step 3: Rewrite `src/embed.ts`**

Replace the whole file:
```ts
import type { Env } from "./types";

export const BGE_MODEL = "@cf/baai/bge-base-en-v1.5";

function l2normalize(vec: number[]): number[] {
  let s = 0;
  for (const x of vec) s += x * x;
  const n = Math.sqrt(s) || 1;
  return vec.map((x) => x / n);
}

// Text-to-text prompt embedding via Workers AI. Raw text, NO instruction prefix
// (symmetric similarity); output is L2-normalized to guarantee the shared contract.
export async function bgeTextEmbed(prompt: string, env: Env): Promise<number[]> {
  const out: any = await env.AI.run(BGE_MODEL, { text: prompt });
  const vec = out?.data?.[0];
  if (!Array.isArray(vec) || typeof vec[0] !== "number") {
    throw new Error(`Unexpected embedding response: ${JSON.stringify(out)}`);
  }
  return l2normalize(vec as number[]);
}
```

- [ ] **Step 4: Rename `clip`→`embedder` + `Env` in `src/types.ts`**

Change the `Clip` interface and `Services`, and edit `Env`:
```ts
export interface Embedder { textEmbed(prompt: string): Promise<number[]>; }
// ...
export interface Services {
  embedder: Embedder; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore;
  keys: KeyStore; rateLimiter: RateLimiter;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  email: EmailSender;
}
export interface Env {
  DB: any; VECTORIZE: any; AI: any; RATE_LIMITER?: any;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
  GITHUB_REPO?: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
  PUBLIC_SITE_URL?: string; PUBLIC_API_BASE_URL?: string;
}
```
(Remove the old `Clip` interface, the `clip:` field, and `CLIP_TEXT_EMBED_URL`/`CLIP_EMBED_TOKEN`.)

- [ ] **Step 5: Update the call site in `src/handler.ts`**

Change `const vec = await s.clip.textEmbed(prompt);` to:
```ts
  const vec = await s.embedder.textEmbed(prompt);
```

- [ ] **Step 6: Update `src/index.ts` `buildServices`**

Change the import and the service:
```ts
import { bgeTextEmbed } from "./embed";
// ...in buildServices, replace the clip line:
    embedder: { textEmbed: (p) => bgeTextEmbed(p, env) },
```

- [ ] **Step 7: Update `test/fakes.ts`**

Replace the `clip` line in `fakeServices` `base`:
```ts
    embedder: { textEmbed: async () => [0.1, 0.2, 0.3] },
```

- [ ] **Step 8: Run the full worker suite (GREEN)**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: all pass, tsc clean. Fix any remaining `clip` references the compiler flags.

- [ ] **Step 9: Commit**

```bash
git add projects/worker/src/embed.ts projects/worker/src/types.ts projects/worker/src/handler.ts projects/worker/src/index.ts projects/worker/test/fakes.ts projects/worker/test/embed.test.ts
git commit -m "feat(worker): embed query prompts with Workers AI BGE (clip→embedder)"
```

---

### Task 2: Worker — wrangler AI binding, index, floor, config

**Files:**
- Modify: `projects/worker/wrangler.toml`
- Modify: `projects/worker/src/index.ts` (floor defaults in the generate cfg)
- Modify: `projects/worker/README.md` (embedding section)

- [ ] **Step 1: Edit `wrangler.toml`**

- Add the Workers AI binding (top-level):
```toml
[ai]
binding = "AI"
```
- Point Vectorize at the new index:
```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "wagmiphotos-bge"
```
- In `[vars]`, **remove** the `CLIP_TEXT_EMBED_URL` line, set the floor placeholders, and update the secrets comment (drop `CLIP_EMBED_TOKEN`):
```toml
FLOOR_SIM_MAX = "0.90"
FLOOR_SIM_MIN = "0.72"
# Secrets (set with `wrangler secret put`): MASTER_API_KEY, RESEND_API_KEY
```

- [ ] **Step 2: Update floor defaults in `src/index.ts`**

In the generations handler's `cfg`, change the fallbacks:
```ts
          floorSimMax: numEnv(env.FLOOR_SIM_MAX, 0.90),
          floorSimMin: numEnv(env.FLOOR_SIM_MIN, 0.72),
```

- [ ] **Step 3: Verify the config bundles**

Run: `cd projects/worker && npx wrangler deploy --dry-run 2>&1 | tail -20`
Expected: bundles; the binding list includes `AI` and the `wagmiphotos-bge` vectorize binding. Placeholder `database_id`/auth warnings are fine.

- [ ] **Step 4: Update `README.md`**

Replace the CLIP/embedder description with: the Worker embeds query prompts with Workers AI `@cf/baai/bge-base-en-v1.5` (768-dim, text-to-text), queries the `wagmiphotos-bge` Vectorize index; there is no external embed endpoint. Note the floor values are BGE-tuned placeholders.

- [ ] **Step 5: Run tests + commit**

Run: `cd projects/worker && npx vitest run` (still green — this task is config).
```bash
git add projects/worker/wrangler.toml projects/worker/src/index.ts projects/worker/README.md
git commit -m "feat(worker): AI binding, wagmiphotos-bge index, BGE floor defaults"
```

---

### Task 3: Common — local BGE embedder + config

**Files:**
- Create: `projects/common/src/sharedcache/common/bge.py`
- Delete: `projects/common/src/sharedcache/common/clip.py`, `projects/common/tests/test_clip.py`
- Modify: `projects/common/src/sharedcache/common/config.py`
- Test: `projects/common/tests/test_bge.py`
- Modify: `projects/common/tests/test_config.py`, `projects/common/tests/test_floor.py`

**Interfaces:**
- Produces:
  - `BgeEmbedder(encoder).text_embed(text: str) -> list[float]` (L2-normalized)
  - `BgeEmbedder.from_pretrained(model_name="BAAI/bge-base-en-v1.5") -> BgeEmbedder`
  - `BGE_MODEL = "BAAI/bge-base-en-v1.5"`

- [ ] **Step 1: Write `test/test_bge.py` (RED)**

```python
import math
from sharedcache.common.bge import BgeEmbedder

class FakeEncoder:
    def encode(self, texts): return [[3.0, 4.0] for _ in texts]  # un-normalized

def test_text_embed_l2_normalizes_the_contract():
    v = BgeEmbedder(FakeEncoder()).text_embed("a red fox")
    assert math.isclose(v[0], 0.6, abs_tol=1e-6)
    assert math.isclose(v[1], 0.8, abs_tol=1e-6)
    assert math.isclose(math.sqrt(sum(x*x for x in v)), 1.0, abs_tol=1e-6)

def test_text_embed_passes_raw_text_no_prefix():
    seen = {}
    class E:
        def encode(self, texts): seen["texts"] = texts; return [[1.0, 0.0]]
    BgeEmbedder(E()).text_embed("hello world")
    assert seen["texts"] == ["hello world"]   # exact text, no instruction prefix
```

- [ ] **Step 2: Run — expect FAIL**

Run: `uv run pytest projects/common/tests/test_bge.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `bge.py`**

```python
"""BGE text embeddings (bge-base-en-v1.5). Shared contract with the Worker's
Workers AI BGE: raw text, NO instruction prefix (symmetric similarity), CLS
pooling, L2-normalized, 768-dim. Heavy deps (sentence-transformers/torch) are
imported lazily so the workspace and unit tests stay light."""
import math
from typing import Protocol

BGE_MODEL = "BAAI/bge-base-en-v1.5"


class TextEncoder(Protocol):
    def encode(self, texts: list[str]) -> list[list[float]]: ...


def _l2(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


class BgeEmbedder:
    def __init__(self, encoder: TextEncoder):
        self._enc = encoder

    def text_embed(self, text: str) -> list[float]:
        vec = [float(x) for x in self._enc.encode([text])[0]]
        return _l2(vec)  # idempotent; guarantees the L2-normalized contract

    @classmethod
    def from_pretrained(cls, model_name: str = BGE_MODEL) -> "BgeEmbedder":
        from sentence_transformers import SentenceTransformer  # lazy, heavy

        model = SentenceTransformer(model_name)

        class _STEncoder:
            def encode(self, texts: list[str]) -> list[list[float]]:
                # no prefix (symmetric); normalize for the contract
                return model.encode(texts, normalize_embeddings=True).tolist()

        return cls(_STEncoder())
```

- [ ] **Step 4: Edit `config.py`**

Remove the three `clip_*` fields; add a BGE model field and BGE-tuned floor defaults:
```python
    bge_model_name: str = "BAAI/bge-base-en-v1.5"
    floor_sim_max: float = 0.90
    floor_sim_min: float = 0.72
```
(Delete `clip_text_embed_url`, `clip_image_embed_url`, `clip_embed_token`.)

- [ ] **Step 5: Delete CLIP + update dependent tests**

```bash
git rm projects/common/src/sharedcache/common/clip.py projects/common/tests/test_clip.py
```
In `tests/test_config.py`: remove `CLIP_TEXT_EMBED_URL`/`CLIP_IMAGE_EMBED_URL`/`CLIP_EMBED_TOKEN` from the monkeypatched env list and drop the `s.clip_text_embed_url is None` assertion.
In `tests/test_floor.py`: rename `test_floor_uses_clip_calibrated_defaults` → `test_floor_uses_bge_calibrated_defaults` and assert the floor from `similarity_floor(0.15, 0.90, 0.72)` (compute the expected value the same way the existing test does, with the new sim_max/min).

- [ ] **Step 6: Run + commit**

Run: `uv run pytest projects/common -q`
Expected: pass.
```bash
git add projects/common
git commit -m "feat(common): local BGE embedder + config; drop CLIP client"
```

---

### Task 4: Backfill — BGE index path (worker + seed)

**Files:**
- Modify: `projects/backfill/src/sharedcache/backfill/worker.py`
- Modify: `projects/backfill/src/sharedcache/backfill/seed_pd12m.py`
- Test: `projects/backfill/tests/test_backfill.py`, `projects/backfill/tests/test_seed_pd12m.py`

**Interfaces:**
- Consumes: `BgeEmbedder.text_embed` (Task 3), `Settings.bge_model_name`.
- Produces: `BackfillWorker(d1, vectorize, embedder, generator, storage, …)` (param `clip`→`embedder`); `seed_pd12m.build_clients(settings) -> (d1, vectorize, embedder)`.

- [ ] **Step 1: Update `test/test_backfill.py` (RED)**

Rename the fake and drop `image_embed`:
```python
class FakeEmbedder:
    def text_embed(self, text): return [float(len(text) % 7)] * 8
```
Replace all `FakeClip()` usages with `FakeEmbedder()`. Add an assertion in the generate-a-new-image test that the upserted vector equals the **prompt** embedding (not a separate image vector) — e.g. capture `vec._upserts` in the fake vectorize and assert its `values` equals `FakeEmbedder().text_embed(prompt)`.

- [ ] **Step 2: Run — expect FAIL**

Run: `uv run pytest projects/backfill/tests/test_backfill.py -q`
Expected: FAIL (`image_embed`/`clip` gone or upsert-vector assertion fails).

- [ ] **Step 3: Edit `worker.py`**

- Rename the constructor param and attribute `clip`→`embedder` (`self._embedder = embedder`).
- In `generate_pass`, compute the prompt vector once and reuse it for the query AND the upsert; drop `image_embed`:
```python
        for q in self._d1.pending_queries(self._batch):
            prompt_vec = self._embedder.text_embed(q.original_prompt)
            match = self._vec.query(prompt_vec, top_k=1)
            if match and match[0]["score"] >= self._floor:
                self._d1.mark_query_built(q.normalized_prompt, match[0]["id"])
                continue
            # ... unchanged spend guards + generate + storage.put + manifest ...
            # replace `image_vec = self._clip.image_embed(original)` (delete it) and
            # change the upsert to use the prompt vector:
            self._vec.upsert(asset_id, prompt_vec, {"source": "generated"})
```
- In `build_worker_from_settings`, build a BGE embedder instead of CLIP:
```python
    from sharedcache.common.bge import BgeEmbedder
    embedder = BgeEmbedder.from_pretrained(s.bge_model_name)
    # ... pass `embedder` positionally where `clip` was:
    return BackfillWorker(d1, vec, embedder, generator, storage, ...)
```
(Remove the `from sharedcache.common.clip import ClipEmbedder` import.)

- [ ] **Step 4: Edit `seed_pd12m.py`**

- `build_clients`: return `(d1, vectorize, embedder)` built from `BgeEmbedder.from_pretrained(settings.bge_model_name)` (drop `ClipEmbedder`).
- `main`: embed the **caption** with BGE; delete the precomputed-image / image-download / CLIP-refuse branch. The per-row logic becomes:
```python
                if prompt and image_url:
                    embedding = embedder.text_embed(prompt)   # BGE caption embedding
                    rows.append({
                        "id": row_data.get("id", len(rows)),
                        "prompt": prompt, "url": image_url,
                        "width": width, "height": height,
                        "mime": "image/jpeg", "embedding": embedding,
                    })
```
- `seed_rows`: unchanged (it already takes `row["embedding"]`), but change the hardcoded `model_used="clip-vit-l-14"` to `model_used=None` (no model produced these; they're seed captions).

- [ ] **Step 5: Update `test/test_seed_pd12m.py`**

`build_clients` now returns an embedder; update the unpacking + assertion to `d1, vectorize, embedder = seed_pd12m.build_clients(settings)` and `assert ... embedder is not None`. Update the `Settings(...)` construction to drop `clip_text_embed_url`/`clip_image_embed_url` (use `bge_model_name` default).

- [ ] **Step 6: Run + commit**

Run: `uv run pytest projects/backfill -q`
Expected: pass.
```bash
git add projects/backfill
git commit -m "feat(backfill): BGE prompt-embedding index path (drop CLIP image vectors)"
```

---

### Task 5: Retire the CLIP embedder service

**Files:**
- Delete: `projects/embedder/` (whole package)
- Modify: `pyproject.toml` (workspace members)
- Modify: `deploy/gmi/docker-compose.yml`, `deploy/gmi/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Remove the package + workspace member**

```bash
git rm -r projects/embedder
```
In `pyproject.toml`, remove `"projects/embedder"` from `[tool.uv.workspace].members`, and remove `projects/embedder/tests` from `[tool.pytest.ini_options].testpaths` if listed.

- [ ] **Step 2: Edit `deploy/gmi/docker-compose.yml`**

Delete the `embedder:` service and the `cloudflared:` service. In the `backfill:` service, remove the `CLIP_TEXT_EMBED_URL`/`CLIP_IMAGE_EMBED_URL` env lines and the `depends_on: embedder` block. Update the top comment to "One-box GMI deployment: backfill worker (in-process BGE)."

- [ ] **Step 3: Edit `deploy/gmi/README.md` + `.env.example`**

Remove the embedder/tunnel setup steps and the `CLIP_TEXT_EMBED_URL`, `CLIP_IMAGE_EMBED_URL`, `CLIP_EMBED_TOKEN`, `EMBED_TOKEN`, `TUNNEL_TOKEN` entries. Note the backfill now loads BGE in-process (`BAAI/bge-base-en-v1.5`).

- [ ] **Step 4: Verify the workspace still resolves + tests pass**

Run: `uv sync && uv run pytest -q`
Expected: sync succeeds without the embedder member; all Python tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A projects pyproject.toml deploy .env.example
git commit -m "chore: retire the CLIP embedder service (BGE runs in-process)"
```

---

### Task 6: Live provisioning + drift check + floor tune (verification)

**Files:** none (operational). Requires real Cloudflare + GMI credentials.

- [ ] **Step 1: Create the BGE Vectorize index**

Run (from `projects/worker`):
```bash
npx wrangler vectorize create wagmiphotos-bge --dimensions=768 --metric=cosine
```

- [ ] **Step 2: Drift check (Worker BGE vs local BGE, cosine ≥ 0.98)**

For a fixture of ~10 strings, embed each with (a) the Worker's Workers-AI BGE (a temporary `/healthz`-style debug call or a one-off `wrangler dev` request that returns the vector) and (b) `BgeEmbedder.from_pretrained().text_embed(...)`, and assert pairwise cosine ≥ 0.98. Record the min cosine. If it fails, reconcile preprocessing (an accidental prefix, wrong pooling, or missing normalization on one side).

- [ ] **Step 3: Seed the pool**

Run: `uv run python -m sharedcache.backfill.seed_pd12m --limit 100`
Confirm Vectorize `wagmiphotos-bge` receives 100 vectors and D1 `assets` gets the rows.

- [ ] **Step 4: Deploy + tune the floor**

`cd projects/worker && npm run deploy`. Send representative prompts; observe the returned `similarity` scores; adjust `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN` (wrangler `[vars]` + `sharedcache.common.config`) so everyday prompts land as `hit` and loosely-related ones as `approximate`. Record the tuned values.

- [ ] **Step 5: Commit the tuned floor (if changed)**

```bash
git add projects/worker/wrangler.toml projects/common/src/sharedcache/common/config.py
git commit -m "chore: tune BGE similarity floor against the seeded pool"
```

---

## Self-Review

**Spec coverage:**
- Worker search → Workers AI BGE + `embedder` rename → Task 1; AI binding/index/floor/config → Task 2. ✓
- Shared embedding contract (no prefix, CLS pooling, L2-normalize) → Task 1 (`bgeTextEmbed` normalizes) + Task 3 (`BgeEmbedder` normalizes) + Global Constraints. ✓
- Backfill/seed local BGE (prompt/caption embeddings) → Tasks 3–4. ✓
- Retire CLIP embedder → Task 5. ✓
- Greenfield provisioning + drift check + floor tune → Task 6. ✓
- Config removals (`CLIP_*`, `EMBED_TOKEN`, `TUNNEL_TOKEN`), `EMBEDDING_DIMS`=768 → Tasks 2/3/5. ✓

**Placeholder scan:** Floor values are declared placeholders per spec (tuned in Task 6); every code step has concrete code. Task 6 is operational (no unit tests by nature — it's the live gate). ✓

**Type consistency:** `bgeTextEmbed(prompt, env)` / `Embedder.textEmbed` / `Services.embedder` (Worker) and `BgeEmbedder.text_embed` / `from_pretrained` / `bge_model_name` (Python) are used consistently across Tasks 1–4. Backfill `BackfillWorker(…, embedder, …)` matches its Task-4 construction. Floor `0.90/0.72` consistent across wrangler, index.ts, config.py, test_floor. ✓

## Notes / follow-ups (from spec)
- `sharedcache → wagmiphotos` rename of existing resources/packages is a separate task.
- Task 6 needs real Cloudflare (Workers AI + Vectorize) + GMI credentials; it's the live gate, run at deploy time.
