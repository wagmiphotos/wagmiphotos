# SharedCache — Handoff / Resume Here

_Last updated: 2026-07-02. Everything below is merged to `main` and green
(Python **42 passed**, Worker **34 passed**)._

## What SharedCache is

An **OpenAI-compatible image-generation cache**. A prompt is CLIP-embedded and matched (cosine, cross-modal
text→image) against a pool of images in **Cloudflare Vectorize**; a near match is served instantly from
**Backblaze B2** (a cache HIT saves a real generation). Novel prompts are logged and generated **asynchronously**
by a background worker — the request path never blocks on generation.

## Architecture (current)

Two deployables over three shared stores:

- **Cloudflare Worker** (`projects/worker/`, TypeScript) — the edge request path **and** the static UI.
  Handles `POST /v1/images/generations`, `POST /v1/keys/generate`, `GET /healthz`; serves the playground SPA
  for every other path via **Workers Static Assets**. It authenticates, CLIP-embeds the prompt, queries
  Vectorize for the nearest asset, reads/logs the query to D1, and returns the image URL. **It never generates.**
  Branch outcomes: `hit` (≥ floor), `approximate` (< floor, nearest served anyway), `pending` (`202`, empty pool).
- **Python backfill worker** (`projects/backfill/`, `python -m sharedcache.backfill`) — the "Hermes runner".
  Polls D1 for pending queries (ranked by demand) and generates the most-requested missing images via
  Genblaze/GMI Cloud, **re-checking Vectorize first** so nothing is built twice; also rehosts seeded PD12M
  images to B2 in 3 webp sizes. Runs locally or in a GMI Cloud Hermes agentbox (Dockerfile included).
- **Shared stores:** **D1** (query log + asset metadata + hashed api keys), **Vectorize** (768-dim CLIP
  ViT-L/14 vectors — reuses PD12M's precomputed image vectors), **Backblaze B2** (image bytes).

Data flow: Worker logs demand → backfill builds top misses → Vectorize/D1 updated → next identical/similar
request is a HIT. Similarity floor is **CLIP-cross-modal-calibrated** (`FLOOR_SIM_MAX/MIN` default 0.35/0.18 —
CLIP cosines are low; tune against the real pool).

## Repo layout (uv workspace monorepo)

```
projects/
├── worker/        # Cloudflare Worker (TS) + public/index.html (the SPA)   — `npm test`, `npm run deploy`
├── common/        # sharedcache-common     — models, config, floor, clip, D1/Vectorize REST clients
├── generation/    # sharedcache-generation — Genblaze/GMI + Backblaze B2 + image processing
└── backfill/      # sharedcache-backfill   — demand-ranked runner (worker.py, seed_pd12m, __main__, Dockerfile)
docs/superpowers/  # specs + plans (the full design/decision trail)
pyproject.toml     # uv virtual workspace root ; uv.lock
```
Python dep graph: `common ← generation ← backfill`. Imports are `sharedcache.common.*` / `.generation.*` / `.backfill.*` (PEP 420 namespace).

## How to run / test / build

```bash
# Python (offline, fakes for D1/Vectorize/CLIP/B2)
uv sync && uv run pytest -q                      # 42 passed

# Worker (offline, faked bindings — no Miniflare)
cd projects/worker && npm install && npm test    # 34 passed

# Build each Python package into a wheel
uv build --package sharedcache-{common,generation,backfill}

# Run the backfill once (needs real env for real work; stub/in-memory otherwise)
uv run python -m sharedcache.backfill --once

# Preview the Worker + SPA locally
cd projects/worker && npx wrangler dev
```

## Domains & public URLs

- Route BOTH custom domains to this worker: `wagmi.photos` (site + API) and
  `api.wagmi.photos` (documented API base for external developers).
- `[vars]` `PUBLIC_SITE_URL` / `PUBLIC_API_BASE_URL` hold the canonical URLs.
  The SPA ships them as defaults; the worker substitutes overrides at serve
  time (`src/rewrite.ts`), so a dev deployment (e.g. `dev.wagmi.photos` /
  `api.dev.wagmi.photos`) renders its own URLs in docs and examples.
- Local overrides go in `projects/worker/.dev.vars` (git-ignored). The SPA's
  own requests are origin-relative, so local dev needs no configuration.

## Design trail

- `docs/superpowers/specs/2026-07-01-cloudflare-edge-cache-design.md` — the Worker + backfill re-architecture.
- `docs/superpowers/specs/2026-07-02-monorepo-restructure-design.md` — the uv-workspace monorepo.
- `docs/superpowers/specs/2026-07-02-worker-served-frontend-design.md` — serving the SPA from the Worker.
- Matching plans under `docs/superpowers/plans/`.
- (A local, git-ignored execution ledger lives at `.superpowers/sdd/progress.md`.)

## Next steps (prioritized)

### 1. Live verification — needs real Cloudflare / Backblaze / GMI / CLIP credentials
This is the biggest open item: everything is verified offline with fakes; nothing has run against live infra.
- Provision + migrate D1: `cd projects/worker && npx wrangler d1 create sharedcache`, set `database_id` in
  `wrangler.toml`, `npx wrangler d1 migrations apply sharedcache`.
- Create the Vectorize index: `npx wrangler vectorize create sharedcache-clip --dimensions=768 --metric=cosine`.
- Wire the CLIP endpoints (`CLIP_TEXT_EMBED_URL` for the Worker; `CLIP_TEXT_EMBED_URL` + `CLIP_IMAGE_EMBED_URL`
  for the backfill). **Confirm PD12M actually exposes precomputed CLIP _image_ vectors** — if not, the seeder
  falls back to CLIP-embedding captions (it refuses to seed zero vectors).
- Seed: `uv run python -m sharedcache.backfill.seed_pd12m --limit 100`.
- **Tune `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN`** against the seeded pool (CLIP cross-modal cosines are low, ~0.2–0.35).
- **Deploy order dependency:** this branch requires `cd projects/worker && npx wrangler d1 migrations apply
  sharedcache` (remote) to run **before** `npm run deploy` — migrations `0002` (`queries.generate`, backfill
  demand tracking) and `0003` (assets browse index) must be live first. Deploying the Worker ahead of these
  migrations breaks demand tracking and hard-errors the Python backfill.
- Deploy the Worker: `cd projects/worker && npm run deploy`; **confirm `wrangler deploy --dry-run` lists the
  `RATE_LIMITER` binding**; then check a request returns a nearest image and the SPA loads at `/`.
- Verify the Vectorize v2 upsert/insert ndjson framing against one live call.

### 2. Branding
The SPA (`projects/worker/public/index.html`) still says **"WagmiPhotos"**; the rest of the project is
**SharedCache**. Pick one and reconcile.

### 3. Deferred hardening (from the reviews — none blocking, triage before real traffic)
- **Backfill:** rehost download is unbounded / no host allowlist (SSRF/OOM risk _once user input can set
  `source_url`_ — add a size cap + allowlist then); spend cap is per-tick not lifetime (consider a daily budget);
  `build_worker_from_settings` silently falls back to `StubGenerator` when keys are absent (warn when unattended);
  generated-asset `manifest.json` isn't persisted to B2 (spec §4.3); backfill Dockerfile runs as root.
- **Worker:** master-key compare isn't constant-time; falsy-but-valid env values (`"0"`) fall through to
  defaults unvalidated; per-key/per-IP throttle on `/v1/images/generations` (only keygen is rate-limited).
- **Tooling:** dev-only `npm audit` findings in wrangler/vitest/esbuild transitive deps.

### 4. Nice-to-haves
- The SPA has no automated test harness (verified by inspection + live). A tiny Playwright smoke test could
  cover the hit/approximate/pending render states.
- `web/index.html` uses `sizes.thumb/medium` are available but unused; could show responsive/thumbnail images.

## Ground truth

- Branch: `main` (all work merged via PRs #1–#3). `git log --oneline -15` shows the history.
- If resuming a multi-step build, use the superpowers brainstorm → writing-plans → subagent-driven-development
  flow (that's how everything above was built).
