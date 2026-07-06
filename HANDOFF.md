# SharedCache — Handoff / Resume Here

_Last updated: 2026-07-07. Everything below is merged to `main`, green
(both offline test suites pass), and pushed to
`github.com/wagmiphotos/wagmiphotos`. **Start here to resume:**
[`docs/HANDOFF-2026-07-07.md`](docs/HANDOFF-2026-07-07.md) — magic-link auth + BGE
edge embeddings shipped; deploy (BGE live provisioning) and the sharedcache→wagmiphotos
rename are the next open items._

## What SharedCache is

An **OpenAI-compatible image-generation cache**. A prompt is BGE-embedded (text-to-text) and matched (cosine)
against a pool of prompts/captions for already-generated images in **Cloudflare Vectorize**; a near match is
served instantly from **Backblaze B2** (a cache HIT saves a real generation). Novel prompts are logged and
generated **asynchronously** by a background worker — the request path never blocks on generation.

## Architecture (current)

Two deployables over three shared stores:

- **Cloudflare Worker** (`projects/worker/`, TypeScript) — the edge request path **and** the static UI.
  Handles `POST /v1/images/generations`, `GET /v1/library`, `GET /v1/library/:id/download`,
  `POST /v1/auth/login`, `GET /v1/auth/verify`, `POST /v1/auth/logout`, `GET /v1/me`,
  `GET /v1/keys`, `DELETE /v1/keys/:id`, `POST /v1/keys/generate`, `GET /v1/meta/stars`,
  and `GET /healthz`; serves the playground SPA for every other path via **Workers Static Assets**. It authenticates, embeds the prompt with **Cloudflare
  Workers AI (`@cf/baai/bge-base-en-v1.5`, text-to-text, 768d)**, queries Vectorize for the nearest asset,
  reads/logs the query to D1, and returns the image URL. **It never generates.**
  Branch outcomes: `hit` (≥ floor), `approximate` (< floor, nearest served anyway), `pending` (`202`, empty pool).
- **Python backfill worker** (`projects/backfill/`, `python -m sharedcache.backfill`) — the "Hermes runner".
  Polls D1 for pending queries (ranked by demand) and generates the most-requested missing images via
  Genblaze/GMI Cloud, **re-checking Vectorize first** so nothing is built twice; also rehosts seeded PD12M
  images to B2 in 3 webp sizes. Embeds asset prompts/captions with a **local** `BAAI/bge-base-en-v1.5`
  (in-process, `model` extra) — no external embedder or tunnel. Runs locally or in a GMI Cloud Hermes
  agentbox (Dockerfile included).
- **Shared stores:** **D1** (query log + asset metadata + hashed api keys + users/sessions/login_tokens), **Vectorize** (768-dim BGE
  `wagmiphotos-bge` index — prompt/caption text vectors), **Backblaze B2** (image bytes).

Data flow: Worker logs demand → backfill builds top misses → Vectorize/D1 updated → next identical/similar
request is a HIT. Similarity floor is **BGE text-to-text-calibrated** (`FLOOR_SIM_MAX/MIN` default 0.90/0.72 —
BGE text-to-text cosines run high; these are placeholders, tune against the real pool).

## Repo layout (uv workspace monorepo)

```
projects/
├── worker/        # Cloudflare Worker (TS) + public/index.html (the SPA)   — `npm test`, `npm run deploy`
├── common/        # sharedcache-common     — models, config, floor, bge, D1/Vectorize REST clients
├── generation/    # sharedcache-generation — Genblaze/GMI + Backblaze B2 + image processing
└── backfill/      # sharedcache-backfill   — demand-ranked runner (worker.py, seed_pd12m, __main__, Dockerfile)
docs/superpowers/  # specs + plans (the full design/decision trail)
pyproject.toml     # uv virtual workspace root ; uv.lock
```
Python dep graph: `common ← generation ← backfill`. Imports are `sharedcache.common.*` / `.generation.*` / `.backfill.*` (PEP 420 namespace).

## How to run / test / build

```bash
# Python (offline, fakes for D1/Vectorize/BGE/B2) — all tests should pass
uv sync && uv run pytest -q

# Worker (offline, faked bindings — no Miniflare) — all tests should pass
cd projects/worker && npm install && npm test

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

## GMI box (backfill)

- One CPU GMI instance runs `deploy/gmi/docker-compose.yml`: just the backfill
  worker container. It loads `BAAI/bge-base-en-v1.5` in-process
  (`sentence-transformers`) to embed asset prompts/captions — there is no
  separate embedding service and no tunnel to stand up.
- The Worker embeds query prompts independently, at the edge, via the
  Cloudflare Workers AI binding (`env.AI.run('@cf/baai/bge-base-en-v1.5', …)`,
  `projects/worker/src/embed.ts`) — no HTTP call to the GMI box.
- Full runbook: `deploy/gmi/README.md`.

## Design trail

- `docs/superpowers/specs/2026-07-01-cloudflare-edge-cache-design.md` — the Worker + backfill re-architecture.
- `docs/superpowers/specs/2026-07-02-monorepo-restructure-design.md` — the uv-workspace monorepo.
- `docs/superpowers/specs/2026-07-02-worker-served-frontend-design.md` — serving the SPA from the Worker.
- Matching plans under `docs/superpowers/plans/`.
- (A local, git-ignored execution ledger lives at `.superpowers/sdd/progress.md`.)

## Next steps (prioritized)

### 1. Live verification — needs real Cloudflare / Backblaze / GMI credentials
This is the biggest open item: everything is verified offline with fakes; nothing has run against live infra.
- Provision + migrate D1: `cd projects/worker && npx wrangler d1 create sharedcache`, set `database_id` in
  `wrangler.toml`, `npx wrangler d1 migrations apply sharedcache`.
- Create the Vectorize index: `npx wrangler vectorize create wagmiphotos-bge --dimensions=768 --metric=cosine`.
- The Worker's query-prompt embedding uses the `[ai] binding = "AI"` Workers AI binding already declared in
  `wrangler.toml` (`@cf/baai/bge-base-en-v1.5`) — no external endpoint to wire. The backfill embeds
  prompts/captions with a local `BAAI/bge-base-en-v1.5` (see `deploy/gmi`).
- Seed: `uv run python -m sharedcache.backfill.seed_pd12m --limit 100`.
- **Tune `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN`** against the seeded pool (BGE text-to-text cosines run high, ~0.7–0.95).
- **Deploy order dependency:** `cd projects/worker && npx wrangler d1 migrations apply
  sharedcache` (remote) must run **before** `npm run deploy` — all migrations through `0006` must be live
  first (see `DEPLOY.md` step 3 for the per-migration notes, including `0004`'s breaking anonymous-key
  wipe). Deploying the Worker ahead of them breaks demand tracking and hard-errors the Python backfill.
- Deploy the Worker: `cd projects/worker && npm run deploy`; **confirm `wrangler deploy --dry-run` lists the
  `RATE_LIMITER` binding**; then check a request returns a nearest image and the SPA loads at `/`.
- Verify the Vectorize v2 upsert/insert ndjson framing against one live call.

### 2. Branding
The SPA (`projects/worker/public/index.html`) still says **"WagmiPhotos"**; the rest of the project is
**SharedCache**. Pick one and reconcile.

### 3. Deferred hardening (from the reviews — none blocking, triage before real traffic)
Most items are now closed — see `docs/HANDOFF-2026-07-04.md` → "Addressed since". Remaining:
- **Backfill:** rehost now has a 25 MB size cap, but still no host allowlist — add one _once user
  input can set `source_url`_ (today it's trusted PD12M seed data only).
- **Deploy:** the non-root Dockerfiles pass `docker build --check` but haven't been built end-to-end
  here (torch/BGE weights) — do a `docker compose up --build` smoke check on the GMI box.
- **Tooling:** dev-only `npm audit` findings in wrangler/vitest/esbuild transitive deps.

### 4. Nice-to-haves
- The SPA has no automated test harness (verified by inspection + live). A tiny Playwright smoke test could
  cover the hit/approximate/pending render states.
- `projects/worker/public/index.html`: the API returns `sizes.thumb/medium`, but the SPA doesn't use them —
  it could serve responsive/thumbnail images instead of the full-size URL.

## Ground truth

- Branch: `main` (all work merged via PRs #1–#3). `git log --oneline -15` shows the history.
- If resuming a multi-step build, use the superpowers brainstorm → writing-plans → subagent-driven-development
  flow (that's how everything above was built).
