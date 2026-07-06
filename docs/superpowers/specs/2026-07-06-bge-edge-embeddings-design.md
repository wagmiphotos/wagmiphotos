# BGE edge embeddings (CLIP → BGE text-to-text) — design

**Date:** 2026-07-06
**Status:** Approved

## Purpose

Move semantic matching from CLIP cross-modal embeddings (ViT-L/14, 768-dim, served by
an external self-hosted embedder at `embed.wagmi.photos`) to **BGE `bge-base-en-v1.5`
(768-dim) text-to-text** embeddings. The request path embeds the query prompt with
**Cloudflare Workers AI** at the edge — no external embed call — so all *search* work
runs in Cloudflare; the **backfill stays in GMI Cloud** and embeds asset prompts with a
**local** copy of the same model.

This also changes what search matches: from **prompt → image content** (CLIP cross-modal)
to **prompt → the prompt/caption text of already-generated images** (BGE text-to-text) —
the natural model for a prompt cache, confirmed as the intended behavior.

## Scope

- Worker request path: swap the query-embed source from the CLIP HTTP endpoint to
  Workers AI BGE; query a new BGE Vectorize index.
- Backfill + seed (GMI, Python): embed asset **prompt/caption text** with a local BGE
  instead of CLIP image/text vectors; keep writing D1 + Vectorize.
- A shared embedding **contract** so the two runtimes (Workers AI ↔ local) don't drift,
  plus a live drift check.
- Re-index all assets into a new `wagmiphotos-bge` Vectorize index; retune the floor.
- Retire the standalone CLIP embedder (`projects/embedder`, the `deploy/gmi` embedder
  container, the `embed.wagmi.photos` tunnel).

**Out of scope** (explicit follow-ups):
- The `sharedcache → wagmiphotos` rename of existing resources/packages (D1 name,
  worker name, Python `sharedcache.*` namespace, docs) — a separate task. This spec
  only uses the `wagmiphotos` name for **new** artifacts (the `wagmiphotos-bge` index).
- Any change to generation, B2 storage, auth, or the SPA.

## Model & embedding contract (shared, to prevent drift)

Both runtimes MUST implement this exactly; it is the single source of truth:

| Property | Value |
|---|---|
| Model | `bge-base-en-v1.5` (Workers AI: `@cf/baai/bge-base-en-v1.5`; local: `BAAI/bge-base-en-v1.5`) |
| Dimensions | 768 |
| Input | the raw prompt/caption text, **no instruction prefix** (symmetric s2s similarity, not asymmetric retrieval) |
| Pooling | CLS token |
| Normalization | **L2-normalized** output |
| Distance | cosine |

Each codebase encapsulates the model id + preprocessing in one thin module (Worker
`src/embed.ts`; Python `sharedcache.common` embed helper) so there is exactly one place
per side to keep in sync.

**Drift check (live verification, required pre-prod):** embed a fixed fixture of ~10
strings with (a) the Worker's Workers-AI BGE and (b) the backfill's local BGE; assert
pairwise cosine ≥ 0.98. Same weights across two runtimes should be near-identical;
this gate catches a preprocessing mismatch (e.g., an accidental query prefix, wrong
pooling, or missing normalization). It needs a real Cloudflare account (Workers AI), so
it is a live step, not an offline unit test.

## Worker (`projects/worker`)

- `wrangler.toml`: add the Workers AI binding `[ai] binding = "AI"`; point `[[vectorize]]`
  at the new index `wagmiphotos-bge` (768-dim, cosine); **remove** `CLIP_TEXT_EMBED_URL`
  (var) and the `CLIP_EMBED_TOKEN` secret; set retuned `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN`.
- `src/embed.ts`: replace `clipTextEmbed(prompt, env)` with
  `bgeTextEmbed(prompt, env)` → `env.AI.run('@cf/baai/bge-base-en-v1.5', { text: prompt })`,
  returning the 768-dim vector. **Always L2-normalize** the output (idempotent — safe if
  the binding already normalizes; guarantees the contract regardless). No instruction prefix.
- Rename the `clip` service to **`embedder`** (the name "clip" is now wrong) across
  `src/types.ts` (`Services.embedder`, `Embedder` interface), `src/index.ts`
  (`buildServices`), `src/handler.ts` (the `s.embedder.textEmbed(prompt)` call site),
  and `test/fakes.ts`. `Env` gains `AI: any`; drop `CLIP_TEXT_EMBED_URL`/`CLIP_EMBED_TOKEN`.
- Tests: `test/embed.test.ts` mocks `env.AI.run` (returns a fixed 768-vector); asserts the
  model id and that no outbound `fetch` occurs. `router`/`handler` tests updated for the
  `embedder` rename (behavior unchanged — still `hit`/`approximate`/`pending` by score).

## Backfill + seed (`projects/backfill`, `projects/common`)

- Add a local BGE embed helper (`BAAI/bge-base-en-v1.5` via sentence-transformers; CPU is
  fine, ~110M params) implementing the shared contract; expose `embed_text(texts) ->
  list[list[float]]`.
- Backfill generate pass: on a generated miss, embed its **prompt text** (not the image)
  and upsert to Vectorize; D1 insert unchanged.
- `seed_pd12m`: embed each PD12M **caption** and upsert (no image download needed for the
  embedding). Refuse to seed zero/degenerate vectors (existing guard, retained).
- Remove the CLIP embedder HTTP client (`ClipEmbedder`), `CLIP_TEXT_EMBED_URL`,
  `CLIP_IMAGE_EMBED_URL`, `CLIP_EMBED_TOKEN`, and the periodic re-rank-by-re-embed pass
  (a prompt's BGE vector is deterministic, so re-embedding on a schedule is unnecessary).
- Backfill keeps its Cloudflare creds (`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DATABASE_ID`,
  Vectorize index) — it still writes D1 + Vectorize.

## Re-index & cutover

1. Create the new Vectorize index: `wrangler vectorize create wagmiphotos-bge
   --dimensions=768 --metric=cosine`.
2. Re-index existing assets: iterate all D1 `assets`, BGE-embed each `prompt`, upsert into
   `wagmiphotos-bge` (a one-shot backfill pass/script).
3. Re-run `seed_pd12m` (BGE captions) for the initial pool if needed.
4. Point the Worker + backfill at `wagmiphotos-bge`, deploy, verify, then delete the old
   `sharedcache-clip` index.

Because the vector space changes, this is a hard cutover — the old CLIP index cannot be
queried with BGE vectors. Sequence: reseed the new index → deploy Worker → delete old.

## Retire the CLIP embedder

Nothing calls it after cutover:
- Delete `projects/embedder` (the open_clip HTTP service) and its tests.
- Remove the `embedder` + `cloudflared` (embed tunnel) services from `deploy/gmi`.
- Remove `EMBED_TOKEN`, the embedder `TUNNEL_TOKEN`, and `embed.wagmi.photos` DNS/tunnel.
- The GMI box still runs the backfill (generation), now with in-process BGE.

## Config / secrets summary

- **Worker:** + `[ai]` binding; index → `wagmiphotos-bge`; − `CLIP_TEXT_EMBED_URL`,
  `CLIP_EMBED_TOKEN`; retuned `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN`.
- **Backfill/.env:** − `CLIP_TEXT_EMBED_URL`, `CLIP_IMAGE_EMBED_URL`, `CLIP_EMBED_TOKEN`,
  `EMBED_TOKEN`, embedder `TUNNEL_TOKEN`; + local BGE model dependency.
- `EMBEDDING_DIMS` stays 768.

## Similarity floor retune

BGE text-to-text cosines run much higher than CLIP cross-modal (close prompts ~0.85–0.95
vs CLIP ~0.2–0.35). `similarityFloor(tol, floorMax, floorMin)` maps tolerance 0..1 to a
cosine floor; set placeholder defaults `FLOOR_SIM_MAX = 0.90`, `FLOOR_SIM_MIN = 0.72`,
then **live-tune** against the reseeded pool so `hit` / `approximate` land in the intended
bands. These placeholders are starting points, not final values.

## Testing

- **Worker (offline):** `embed.test.ts` mocks `env.AI.run` → asserts model id, 768-dim,
  no outbound fetch; `handler`/`router` behavior unchanged (score → hit/approximate/pending).
- **Backfill (offline):** the BGE helper returns 768-dim L2-normalized vectors of the
  expected shape; generate/seed embed the **prompt** text; no CLIP references remain.
- **Live:** the drift check (Worker BGE vs local BGE cosine ≥ 0.98); floor tune against
  the reseeded pool; a first request returns a nearest image with a plausible BGE score.

## Rollout order

1. Worker → BGE (Workers AI, `embedder` rename, new index binding, floor placeholders).
2. Backfill/seed → local BGE (shared contract module).
3. Create `wagmiphotos-bge`, reseed/re-index, run the drift check + floor tune.
4. Deploy Worker, cut over, delete the old CLIP index, retire the embedder service.
