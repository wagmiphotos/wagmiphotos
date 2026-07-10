# wagmi.photos — Handoff / Resume Here

> **2026-07-10 (later session): READ/WRITE SPLIT SHIPPED TO PROD** (main@a347c17,
> worker `5aeb58e1`, 14 reviewed commits). The read endpoint is a pure closest-match
> lookup (`cache_tolerance`/`generate_on_miss` REMOVED); creation is a new async,
> BYOK-gated, collection-scoped flow (`POST /v1/collections/:id/generations` → 202
> ticket → `GET /v1/generations/:id` poll-through; cron sweep every 2 min, migration
> **0016** applied remote). **gpt-image-2 is BACK** (OpenAI Responses background mode,
> probe-verified 70s, contract re-pinned @ $0.055); GMI decomposed to submit/check.
> SPA: playground page deleted — `#/library` now has Library|Collections tabs with the
> generate box + BYOK key management. Shared library is operator-backfill-only
> (collection assets excluded from unscoped reads). New real-schema D1 test harness
> (`test/real-d1.ts`) — it caught a would-be-shipped FK bug in review.
> **REMAINING — Joris, do later (everything else is deployed):**
>
> 1. **Prod smoke with a real key:** wagmi.photos → log in → Library → **Collections
>    tab** → confirm key status → pick/create a collection → generate. The loader
>    polls (~70s on gpt-image-2); the image must land in the collection grid, and
>    must **NOT** appear in the shared library search. Usage/spend note should read
>    real numbers (no $0.00 after success, no NaN).
> 2. **Sweep check:** start a generation, close the tab, wait ~4 min, reopen the
>    ticket-holding collection — the cron sweep should have finished (or refunded)
>    it. Optionally watch one generation via `npx wrangler tail`.
> 3. **OpenAI refund ticket** for the pre-split billed-undelivered generations
>    (~$1.50, user action — unchanged from the morning handoff).
> 4. **Live Stripe config** still pending (Upgrade button errors until done; see
>    HANDOFF-2026-07-09).
> 5. Deferred post-merge polish (non-blocking, list at the end of
>    `.superpowers/sdd/progress.md`): `bpoll:` limiter on the ticket GET,
>    org-verification hint in the generate-card error path, provider test gaps
>    (GMI media_urls object shape, 401/403 halves), observe one live OpenAI
>    background *failure* payload before trusting its error-field parsing,
>    stale-claim-TTL + GET-404-row-missing test coverage, `?tab=` deep link for
>    the Collections tab.
>
> Spec:
> [`docs/superpowers/specs/2026-07-10-read-write-split-async-collection-gen-design.md`](docs/superpowers/specs/2026-07-10-read-write-split-async-collection-gen-design.md).

> **2026-07-10 (morning):** Big day shipped and verified live: **collections + progressive slots**,
> **library seeded to 11,005 images**, UI polish batch, and **BYOK generation proven
> end-to-end in prod** (gpt-image-1 medium, webp, SSE streaming) after a long live debug —
> two real bugs fixed (post-0007 `url` column in `insertGenerated`; OpenAI's ~20s idle-kill
> of silent image connections, which also forced reverting a gpt-image-2 attempt).
> ~~NEXT TASK: async BYOK generation~~ — **DONE in the later 2026-07-10 session above**
> ([`docs/HANDOFF-2026-07-10-async-byok-gen.md`](docs/HANDOFF-2026-07-10-async-byok-gen.md)
> is the context that motivated it).

> **2026-07-09:** **BYOK (bring-your-own-key generation) is LIVE in production** — users can
> store an OpenAI/GMI key and fresh-generate below-tolerance prompts into the shared library.
> Also live: the asset origin is now **`cdn.wagmi.photos/assets/…`** (via a Cloudflare
> Transform Rule — see the handoff's ⚠️) and a homepage refresh (compare section moved,
> tabless API cards, open-license CTA band). The **live Stripe config is still pending**
> (Upgrade button errors until it's done). Resume from
> [`docs/HANDOFF-2026-07-09-byok-live-stripe-pending.md`](docs/HANDOFF-2026-07-09-byok-live-stripe-pending.md).

> **2026-07-08:** Stripe billing (annual $24/yr subscription + paid-API gating) merged to
> `main` and verified end-to-end locally — [`docs/HANDOFF-2026-07-08-stripe-billing.md`](docs/HANDOFF-2026-07-08-stripe-billing.md)
> (its §2 production steps are partially superseded; see the 2026-07-09 handoff).

_Last updated: 2026-07-07 (evening session, after launch). **The product is
LIVE at [wagmi.photos](https://wagmi.photos)**. This session shipped two
reviewed features, both deployed: (1) the rehosted `large` variant is capped at
2048px and the pd12m source is exposed as `original_url` in the API + a
"View original" link in the playground; (2) rehosting is demand-ranked and dead
sources get tombstoned (migration **0008**: `dead_at`/`dead_reason` + the
`live_assets` view every Worker read now goes through). Migration 0008 is
APPLIED to prod D1 and the Worker is deployed (version `937f9713`). The one
missing organ is still the GMI backfill box (step 4 of `DEPLOY.md`): until it
runs, queued generations don't build, nothing rehosts, and none of today's
backfill-side code has ever executed against live infra. Everything is merged
to `main` and pushed._

## What's live right now (verified 2026-07-07)

- **`wagmi.photos` + `api.wagmi.photos`** → `wagmiphotos-worker` (workers.dev +
  preview URLs disabled). Magic-link login works end-to-end via Resend
  (sender `noreply@mail.suppers.ai`).
- **D1 `wagmiphotos`** migrated 0001–**0008**; contents at session end: 1 user,
  1,000 assets (all alive through the new `live_assets` view), 4 pending demand
  queries (real playground prompts, correctly scored ~0.71–0.78 vs the
  museum-heavy seed pool and queued).
- **Rehost pipeline semantics (new this session, deployed but never yet run):**
  `assets_needing_rehost` is demand-first (ranked by `SUM(queries.count)` per
  `last_asset_id`, FIFO trickle fills leftover slots); `large` is capped at
  2048px longest side (`MAX_LARGE_DIM`, never upscales); HTTP 404/410 from a
  source tombstones immediately (`dead_at`/`dead_reason`, no retry spend),
  retry exhaustion (5) tombstones too; death is D1-first then best-effort
  vector delete (Worker skips orphan vectors). Tombstones are reversible
  (`UPDATE assets SET dead_at=NULL`). Reads must go through `live_assets` —
  the view owns the invariant; writes target `assets`.
- **API additions:** `original_url` (source image, `null` for generated) sits
  next to `sizes` in the generate response and on library items; the playground
  shows "View original ↗" links.
- **Vectorize**: 3 shards `wagmiphotos-bge-0/1/2` holding 333/343/324 vectors —
  fnv1a32 write-routing balance confirmed live.
- **Assets CDN path**: `https://cdn.wagmi.photos/assets/{id}/<size>.webp`
  (Cloudflare-proxied B2 `wagmi-photos-library`; a Transform Rule prepends
  `/file/wagmi-photos-library` so public URLs hide the vendor/bucket; free
  egress via the Backblaze/Cloudflare partnership, 1-year cache rule; keys are
  immutable). Renamed from the never-created `images.wagmi.photos` 2026-07-09.
  Worker `ASSET_BASE_URL` == backfill `B2_PUBLIC_URL_BASE` — the seam check is
  `curl -I` a rehosted `thumb_url` (see `DEPLOY.md` Verify).
- **BGE drift check PASSED at cosine 1.0000** — after discovering live that
  Workers AI **mean-pools** (BGE ships CLS): `BgeEmbedder.from_pretrained`
  force-flips pooling and raises if it can't. Never swap the embedding stack
  without re-running the drift check.
- **Floors tuned against the live pool**: `FLOOR_SIM_MAX=0.87` /
  `FLOOR_SIM_MIN=0.75` (verbatim 1.00, paraphrase 0.87–0.91, related ~0.79,
  unrelated ≤0.71). Pinned in `contract.json` + both runtimes; re-probe as the
  pool grows.

## What wagmi.photos is

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
  and `GET /healthz`; serves the playground SPA for every other path via **Workers Static Assets**.
  It authenticates, embeds the prompt with **Cloudflare Workers AI**
  (`@cf/baai/bge-base-en-v1.5`, 768d), queries Vectorize (3-shard fan-out, merged by max score),
  reads/logs the query to D1, and returns derived asset URLs. **It never generates.**
  Branch outcomes: `hit` (≥ floor), `approximate` (< floor, nearest served anyway, generation queued),
  `pending` (`202`, empty pool). `GET /v1/library?q=` is semantic too (same BGE path, 0.75 relevance
  floor, top-100 window) with the old SQL `LIKE` scan as automatic fallback on any semantic-path error
  (that fallback is what offline local dev exercises).
- **Python backfill worker** (`projects/backfill/`, `wagmiphotos-backfill`) — polls D1 for pending
  queries (demand-ranked, claim/lease + 5-attempt budgets) and generates the most-requested missing
  images via Genblaze/GMI Cloud, **re-checking Vectorize first** so nothing is built twice; rehosts
  seeded images to B2 in 3 webp sizes at the contract-pinned keys. Embeds with a **local, mean-pooled**
  `BAAI/bge-base-en-v1.5` (in-process, `[model]` extra). Durable lifetime spend cap in the D1 `meta` table.
- **Shared stores:** **D1** (query log + slim asset metadata — URLs are DERIVED, not stored (migration
  0007) + hashed api keys + users/sessions/login_tokens), **Vectorize** (3 shards, write-routed
  `fnv1a32(id) % 3`), **Backblaze B2** (image bytes at `assets/<id>/{image,medium,thumb}.webp`).

Cross-language constants (floors, tolerance, BGE model ids, shard prefix/count + fixtures, asset path
templates) live in repo-root **`contract.json`**, parity-asserted by BOTH test suites — change values
there first; drift fails CI on either side.

## Repo layout (uv workspace monorepo)

```
projects/
├── worker/        # Cloudflare Worker (TS) + public/index.html (the SPA)   — `npm test`, `npm run deploy`
├── common/        # wagmiphotos-common     — models, config, floor, shard, bge, asset_paths, D1/Vectorize REST
├── generation/    # wagmiphotos-generation — Genblaze/GMI + Backblaze B2 + image processing
└── backfill/      # wagmiphotos-backfill   — demand-ranked runner (worker.py, seed_pd12m, __main__, Dockerfile)
docs/superpowers/  # specs + plans (the full design/decision trail)
contract.json      # cross-language constants (single source; parity-tested both sides)
pyproject.toml     # uv virtual workspace root ; uv.lock
```
Python dep graph: `common ← generation ← backfill`. Imports are `wagmiphotos.common.*` etc.

## How to run / test / build

```bash
uv sync && uv run pytest projects/ -q          # Python suite (offline fakes) — all green
cd projects/worker && npm install && npm test  # Worker suite — all green; npx tsc --noEmit silent
# Local dev (SPA + D1 offline; needs .dev.vars with DEV_MODE=true):
#   see .claude/skills/running-locally/SKILL.md
# Seed from the local PD12M download (NOT HuggingFace; metadata parquets only):
set -a && source deploy/gmi/.env && set +a
uv run python -m wagmiphotos.backfill.seed_pd12m --metadata-dir ~/data/PD12M/metadata --limit 1000
```

PD12M lives locally at `/home/joris/data/PD12M` (NOT in git): `metadata/` (125 parquet, 12.5M rows)
is what seeding reads; the 36GB `embeddings/` dir is a different model's vectors — unusable, deletable.

## Credentials map (nothing secret in git)

- **Wrangler secrets** (set): `MASTER_API_KEY`, `RESEND_API_KEY` (sending-only key, domain
  `mail.suppers.ai` verified).
- **`deploy/gmi/.env`** (gitignored, FILLED on this machine): CF account/API token (D1+Vectorize edit),
  D1 id, GMI key, B2 keys/bucket, floors. `scp` it to the GMI box when standing it up.
- `DEV_MODE` must never be set in prod — all dev conveniences fail closed without it.

## Next steps (prioritized)

### 1. Stand up the GMI backfill box (`DEPLOY.md` step 4 — the only missing piece)
Provision a CPU GMI instance with Docker → clone the repo → `scp deploy/gmi/.env` across →
`cd deploy/gmi && docker compose up -d --build` (first build pulls CPU torch + BGE weights).
Then: the 4 pending queries should generate within a tick, rehosting starts (demand-first,
2048-capped, tombstoning dead sources), and the `curl -I <thumb_url>` seam check (DEPLOY
Verify) proves the CDN path. Also confirms the non-root Docker image builds end-to-end
(never built here). Stopgap if the box is delayed: one local `uv run wagmiphotos-backfill`
run with `deploy/gmi/.env` sourced drains the 1k pool in a couple of hours.

### 2. Full-scale seed (1k → 12.5M) — needs batching work first
Current seeding inserts D1 rows one REST call each — fine for thousands, days for millions.
Before the big run: batch D1 inserts (D1 REST accepts multi-statement bodies), consider running
the seed on the GMI box, and re-probe the floors after each big batch (coincidental similarity
creeps up with scale). D1 headroom is fine (~4.4GB slim rows at 12.5M vs 10GB cap).
Also parked for this milestone (same method, do together): switch rehost to **demand-only**
(drop the trickle query — don't mirror 12M unrequested images) and add the batch-size guard —
`WORKER_BATCH_SIZE` > ~50 would overflow the trickle query's `NOT IN` under D1's
100-bound-param cap; nothing enforces the ceiling today (default is 5, so no current risk).

### 3. Hardening before real traffic (unchanged from reviews; none blocking)
- Rehost host allowlist once `source_url` can be user-influenced (today: trusted PD12M only).
- Prompt→embedding cache in the Worker (cuts Workers AI calls on the hot path; also the
  mitigation for unthrottled `/v1/library?q=` costs).
- Edge caching on `/v1/library*`; scheduled token/session GC (opportunistic purge already runs).
- A tiny Playwright smoke test for the SPA's hit/approximate/pending states.

### 4. Hackathon deliverables (deadline Aug 3)
Devpost submission + demo video — see `TODO.md`.

## Design trail

- `docs/superpowers/specs/2026-07-07-demand-rehost-tombstones-design.md` (+ plan) — demand-ranked
  rehosting, tombstones, `live_assets` view (this session; 5 tasks, all reviews clean).
- `docs/superpowers/specs/2026-07-07-large-cap-original-url-design.md` (+ plan) — 2048px large
  cap + `original_url` API/playground exposure (this session; one review-caught CSS `[hidden]`
  cascade bug fixed before merge).
- `docs/superpowers/specs/2026-07-07-wagmiphotos-rename-and-scale-design.md` (+ plan) — the
  rename, 3-shard Vectorize, derived URLs, semantic library search (launch session).
- `docs/superpowers/specs/2026-07-06-bge-edge-embeddings.*` — BGE migration; its Task 6
  (live provisioning) was completed this session, with two live-only findings: Workers AI
  mean-pools, and D1 caps bound params at 100/statement.
- Earlier specs/plans under `docs/superpowers/`; execution ledger (git-ignored) at
  `.superpowers/sdd/progress.md`.

## Ground truth

- Branch: `main`, pushed to origin. `git log --oneline -25` tells today's story: launch
  (audit sweep → rename/scale → launch-gate fixes → live config) → large-cap + original_url
  (spec/plan + 4 reviewed tasks) → demand-rehost + tombstones (spec/plan + 5 reviewed tasks,
  migration 0008 applied, Worker deployed).
- If resuming a multi-step build, use the superpowers brainstorm → writing-plans →
  subagent-driven-development flow (that's how everything above was built).
