# SharedCache — Design Spec

- **Status:** Draft (awaiting review)
- **Date:** 2026-06-23
- **Author:** Joris (Suppers Software)
- **Target repo:** `/home/joris/Projects/suppers-ai/sharedcache` (new standalone SaaS)
- **Context:** Built for the **Backblaze Generative Media Hackathon** ("Build with Genblaze on B2"). Submission deadline **Aug 3, 2026, 5:00pm EDT**. Will later replace the `imagelibrary` setup inside mysitebot (the `wypiwyg` monorepo).

---

## 1. Summary

**SharedCache is a semantic cache for generative media, served behind an OpenAI-compatible API.**

A caller requests an image from a prompt. SharedCache embeds the prompt and searches a shared, global vector index of previously-generated media stored in **Backblaze B2**. On a **hit** (a semantically close-enough prior asset), it returns that asset instantly and near-free. On a **miss**, it generates via the **Genblaze** pipeline, stores the asset and its SHA-256 provenance manifest in B2, indexes it, and returns it. The pool compounds across all callers, so hit-rate — and cost savings — rise with usage.

One line: *"Stop paying to regenerate the same image. Cache it once on B2, serve it forever."*

- **Company / house brand:** Suppers Software
- **Product:** SharedCache — `sharedcache.io`
- **First model ID:** `image-cache-1` (family extends to `embedding-cache-1`, `audio-cache-1`, … later)

## 2. Goals / Non-goals

**Goals (hackathon MVP):**
- An OpenAI-compatible `images/generations` endpoint with a `cache_tolerance` knob.
- Hit/miss semantic caching over a B2-backed, shared global media pool.
- Generation-on-miss via the Genblaze pipeline, with provenance manifests persisted to B2.
- A minimal playground web UI that demonstrates hit/miss and a live "$ saved" counter.
- Deployed, publicly testable, with a <3-min demo video and a README documenting B2 + Genblaze usage and the providers/models used.

**Non-goals (for the hackathon window):**
- Full multi-tenant billing/quotas (basic API-key gating only).
- Training our own generation model (we orchestrate providers via Genblaze).
- Migrating mysitebot onto SharedCache (separate follow-up; see §11).
- Per-image license *re-derivation* (we record provenance; we do not re-verify licenses from pixels — see prior CC0 research).

## 3. Hackathon constraints & rubric mapping

Both **Backblaze B2** and the **Genblaze Python SDK** are *required* (hard gate). The four Stage-Two judging criteria are **equally weighted**:

| Criterion | How SharedCache addresses it |
|---|---|
| Real-World Utility | "Stop paying to regenerate the same media." Clear dev audience, measurable savings. |
| Production Readiness | OpenAI-compatible API, metering, durable B2 store, provenance + (stretch) moderation. |
| B2 Storage + Data Orchestration | B2 is the core store: assets, thumbnails, provenance manifests, JSON sidecars. |
| Use of Genblaze | The miss path runs through the Genblaze multi-provider pipeline; manifests captured. |

The hackathon's own example ideas include "AI media libraries (store/organize/search generated assets)" and "agentic media pipelines (generate/evaluate/retry/store)" — SharedCache is squarely on theme.

## 4. Naming & API conventions

- Model IDs follow the `<modality>-<function>-<version>` convention (cf. `text-embedding-001`, `gpt-image-1`): **`image-cache-1`**.
- `cache_tolerance` ∈ [0.0, 1.0]: **0.0 = bespoke (always generate); 1.0 = max reuse (accept the loosest match)**. Internally mapped to a cosine-similarity floor (see §7). Default: **0.15** (conservative reuse) — tunable.

## 5. Architecture

```
POST /v1/images/generations   (OpenAI-compatible: model, prompt, n, size, + cache_tolerance)
        │
   [API layer]  ── auth (api key) ──> [Embedder] prompt → vector
        │
   [Cache index]  pgvector similarity search over assets indexed from B2
        │
   ┌────┴───────────────────────────────────┐
  HIT (similarity ≥ floor)                  MISS
   │                                         │
 [B2 store] fetch asset URL        [Genblaze pipeline] generate (multi-provider)
   │                                         │
 record hit + cost_saved          [Processor] → responsive WebP
   │                                         │
 return asset + metadata          [B2 store] put asset + thumb + manifest + sidecar
                                             │
                                   [Cache index] insert vector + row
                                             │
                                   return asset + metadata
```

## 6. Components (clear boundaries — each independently testable)

1. **API layer** (`api/`) — FastAPI. Exposes OpenAI-compatible `POST /v1/images/generations`, a health check, and serves the playground UI. Validates requests, enforces an API key, returns OpenAI-shaped responses plus SharedCache extension fields. *Depends on:* CacheService.

2. **CacheService** (`core/cache_service.py`) — orchestrates the hit/miss flow: embed → search → (hit) serve / (miss) generate+store+index. The heart of the product. *Depends on:* Embedder, CacheIndex, B2Store, GenblazeAdapter, Processor, CostMeter.

3. **Embedder** (`core/embedder.py`) — prompt text → vector. Reuses the Gemini text-embedding approach from `imagelibrary` (model + dims configurable). *Depends on:* Google GenAI SDK.

4. **CacheIndex** (`core/index.py`) — pgvector-backed vector search + asset rows. Insert, search (top-k by cosine), get. *Depends on:* Postgres + pgvector.

5. **B2Store** (`core/b2_store.py`) — Backblaze B2 via the S3-compatible API (boto3). Put/get asset bytes, thumbnails, `manifest.json`, and a portable `sidecar.json`. Returns retrievable URLs (presigned or via a thin proxy route). *Depends on:* boto3 + B2 credentials.

6. **GenblazeAdapter** (`core/genblaze_adapter.py`) — wraps the Genblaze Pipeline API for the miss path; selects provider/model; returns generated bytes + the SHA-256 provenance manifest. *Depends on:* `genblaze` SDK. **⚠️ The exact Genblaze API shape must be confirmed from `github.com/backblaze-labs/genblaze` before implementation (see §12).**

7. **Processor** (`core/processor.py`) — normalizes generated bytes to responsive WebP (thumb/mobile/desktop). Ports directly from `imagelibrary/processor.py`.

8. **CostMeter** (`core/cost_meter.py`) — per provider/model price table; computes `cost_saved_usd` on each hit; tracks cumulative savings (per key + global) for the playground counter.

9. **Playground UI** (`web/`) — minimal page: prompt box, `cache_tolerance` slider, result image, a HIT/MISS badge with similarity score, and a running "$ saved" counter. The demo money-shot.

10. *(Stretch)* **ModerationGate** (`core/moderation.py`) — Cloud Vision SafeSearch on generated bytes before they enter the shared pool (adult/racy/violence). Ties to prior CC0/safety research; strengthens "Production Readiness."

## 7. Cache hit semantics

- Embed the prompt; query CacheIndex for the nearest asset by cosine similarity.
- Map `cache_tolerance` → a **similarity floor**: `floor = SIM_MAX - cache_tolerance * (SIM_MAX - SIM_MIN)` (constants tuned during dev; e.g. `SIM_MAX=0.98`, `SIM_MIN=0.70`). Higher tolerance ⇒ lower floor ⇒ more hits.
- If `top1.similarity ≥ floor` → **HIT** (return that asset). Else → **MISS** (generate).
- Cold start: an empty pool always misses; the playground should pre-seed a few generations so judges see hits immediately.
- `n > 1`: return up to `n` distinct assets above the floor, generating the remainder.

## 8. Data model

**Postgres `assets`** (vector index + metadata; binary lives in B2):
- `id UUID PK`
- `prompt TEXT`
- `prompt_embedding vector(N)` (HNSW cosine index; N per embedding model)
- `b2_key_original TEXT`, `b2_key_thumb TEXT`, `b2_key_manifest TEXT`, `b2_key_sidecar TEXT`
- `provider TEXT`, `model TEXT` (the Genblaze provider/model used)
- `content_hash TEXT` (SHA-256; dedup)
- `width INT`, `height INT`, `mime TEXT`
- `safety JSONB` (moderation scores; nullable until stretch)
- `provenance JSONB` (key manifest fields)
- `created_at TIMESTAMPTZ`

**Postgres `savings_ledger`** (for the counter): `id`, `api_key_id`, `asset_id`, `cost_saved_usd`, `created_at`.

**B2 layout:** `assets/{id}/original.webp`, `assets/{id}/thumb.webp`, `assets/{id}/manifest.json` (Genblaze provenance), `assets/{id}/sidecar.json` (portable record mirroring the DB row).

## 9. API surface

`POST /v1/images/generations`
- Request (OpenAI-compatible + extensions): `{ "model": "image-cache-1", "prompt": "...", "n": 1, "size": "1024x1024", "cache_tolerance": 0.15 }`
- Response (OpenAI-shaped + extensions):
  ```json
  {
    "created": 0,
    "data": [{ "url": "https://.../assets/<id>/original.webp" }],
    "shared_cache": {
      "result": "hit",            // or "miss"
      "similarity": 0.93,
      "cost_saved_usd": 0.04,     // 0 on miss
      "provider": "openai",       // on miss: who generated it
      "model": "gpt-image-1",
      "provenance_url": "https://.../assets/<id>/manifest.json"
    }
  }
  ```
- OpenAI SDK clients ignore the `shared_cache` block, preserving drop-in compatibility; power users read it.
- Auth: `Authorization: Bearer <api_key>` (simple key check for MVP).

## 10. Cost-savings metering

- A static price table maps `(provider, model)` → USD per image (from public pricing).
- On a hit, `cost_saved_usd` = the price the *would-be* generation would have cost. Recorded in `savings_ledger`; cumulative shown in the playground.
- This is the central "Real-World Utility" demonstration.

## 11. Relationship to mysitebot (future)

SharedCache will replace mysitebot's `imagelibrary`. mysitebot's agent talks to images via the `MediaSearch` protocol (and an OpenAI client). After the hackathon, an adapter will point that protocol at SharedCache's API, so the agent gets cached/generated, rights-clean media without its own ingestion pipeline. **Out of scope for the hackathon build** — noted so the API stays compatible with that future (semantic search + provider-agnostic generation).

## 12. Risks & open questions

1. **Genblaze SDK shape is unverified.** Must read `github.com/backblaze-labs/genblaze` to confirm the Pipeline API, provider config, and manifest format *before* writing GenblazeAdapter. This is implementation step 1.
2. **"Approximate image" acceptance.** A hit returns a *similar* image, not a bespoke one. The `cache_tolerance` knob + clear playground UX mitigate; default conservative.
3. **Cold-start empty cache.** Pre-seed the playground pool so judges see hits.
4. **Embedding model / dims.** Reuse Gemini embedding (configurable); pick dims to match the HNSW index. Prompt-similarity quality drives hit relevance.
5. **B2 URL delivery.** Presigned URLs vs a thin proxy route — decide during build (presigned is simpler).
6. **GMI Cloud credits.** Optional; first 270 signups get credits — worth claiming as a provider option.

## 13. Scope & milestones (≈6 weeks to Aug 3)

- **Week 1:** Verify Genblaze API; scaffold repo (uv project, FastAPI, Postgres+pgvector, B2 bucket); B2Store + CacheIndex with tests.
- **Week 2:** Embedder + CacheService hit/miss flow (TDD); OpenAI-compatible endpoint.
- **Week 3:** GenblazeAdapter miss path + provenance manifests to B2; Processor port; CostMeter.
- **Week 4:** Playground UI (slider, hit/miss, $ saved); pre-seed pool; deploy + public URL.
- **Week 5:** Stretch (ModerationGate, 2nd modality via Genblaze, API keys); polish.
- **Week 6:** Demo video (<3 min), README (B2 + Genblaze + provider/model list), optional Genblaze feedback (Feedback Prize), final submission.

**MVP = Weeks 1–4.** Everything in Week 5 is cuttable.

## 14. Testing strategy

TDD throughout. Unit tests for: `cache_tolerance`→floor mapping and hit/miss decision; Embedder (mocked SDK); CacheIndex search; B2Store (against a stub/local S3 mock); GenblazeAdapter (stubbed SDK); CostMeter pricing. Integration test for the full hit and miss paths with stubs. A stub Genblaze + stub B2 keep the suite offline (mirrors the `imagelibrary` stub-MediaSearch pattern).

## 15. Submission checklist

- [ ] Publicly testable app URL (+ test API key / login instructions)
- [ ] Public GitHub repo with README: what it does, **how it uses B2**, **how it uses Genblaze**, and the **list of AI providers/models used**
- [ ] Demo video <3 min on YouTube/Vimeo
- [ ] (Optional) product feedback via Genblaze repo Issues → Feedback Prize
- [ ] App free to access through the end of the judging period (Aug 11)
