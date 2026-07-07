# DEPLOY — going live

Ordered runbook for the production deploy. **Status 2026-07-07: steps 0–3 and
5–6 are DONE and live** (wagmi.photos + api.wagmi.photos serve the Worker; D1
migrated 0001–0007; three shards seeded with 1k PD12M rows; drift check passed
at cosine 1.0000; floors tuned 0.87/0.75; assets route via CF-proxied
`images.wagmi.photos`). **Step 4 (the GMI backfill box) is NOT up yet** — queued
generations and rehosting wait on it. Kept in full as the rebuild-from-scratch
reference; run steps **in order** — several have hard dependencies.

Prereqs: a Cloudflare account, a Backblaze B2 bucket, a GMI Cloud (CPU) box with
Docker, and a GMI Cloud generation API key. All commands are run from the repo
root unless a `cd` is shown. The Worker requires **wrangler v4** (pinned in
`projects/worker/package.json` — every `npx wrangler …` below picks it up from
there; don't run an older global wrangler).

---

## 0. Authenticate

```bash
cd projects/worker && npx wrangler login
```

## 1. Create D1 and wire its id

D1 does **not** exist yet — `wrangler.toml`'s `database_id` is a placeholder
(nothing has been created against live Cloudflare under any name).

```bash
npx wrangler d1 create wagmiphotos        # copy the database_id it prints
```

Edit `projects/worker/wrangler.toml` → replace the placeholder `database_id`
(line ~9) with the id. (Ask Claude to make this edit if you paste the id.)

## 2. Create the three Vectorize shards

Vectorize is sharded 3-ways (`fnv1a32(id) % 3` picks the write shard, pinned
in `contract.json`); the Worker fans queries out to all three and merges by
score:

```bash
for i in 0 1 2; do
  npx wrangler vectorize create "wagmiphotos-bge-$i" --dimensions=768 --metric=cosine
done
```

If a single unsharded `wagmiphotos-bge` index was ever created (an earlier
iteration of this repo, before sharding), delete it — it's superseded by the
three shards above:

```bash
npx wrangler vectorize delete wagmiphotos-bge
```

## 3. Back up D1, then apply migrations remotely — **BEFORE any deploy**

Take a backup first (migrations are forward-only; this is the rollback path):

```bash
npx wrangler d1 export wagmiphotos --remote --output=backup.sql
```

Then apply all pending migrations. Deploying the Worker ahead of them breaks
demand tracking and **hard-errors the Python backfill**:

- `0002` — `queries.generate`, backfill demand tracking; `0003` — assets browse index.
- `0004` — accounts. ⚠️ **Breaking:** wipes all pre-existing anonymous API keys
  (`DELETE FROM api_keys WHERE user_id IS NULL`); any live integration using a
  self-minted key must sign up and reissue a key from the dashboard.
- `0005` — nonce-bound login tokens; applying it voids outstanding magic links —
  users just request a new one.
- `0006` — backfill reliability (query/rehost attempt tracking + `building`
  claims), the `meta` table (durable backfill spend cap), and a session-expiry index.
- `0007` — drops the stored `thumb_url`/`medium_url`/`url`/`manifest_url` columns.
  Asset URLs are now derived at read time: cached (`locally_cached=1`) assets
  resolve to `{ASSET_BASE_URL}/{asset_paths[size]}` (paths pinned in
  `contract.json`); everything else serves `source_url`. Set `ASSET_BASE_URL`
  before/at deploy (see step 5) — without it, cached assets degrade to
  `source_url` too.
- `0008` — adds `assets.dead_at` and `assets.dead_reason` (demand-ranked
  rehosting + tombstones), the partial index `idx_assets_rehostable`, and the
  `live_assets` view. **Must be applied before the next Worker deploy and
  before the backfill runs this code** — readers reference the view; old code
  against a migrated DB is safe, the reverse is not.

```bash
npx wrangler d1 migrations apply wagmiphotos --remote   # runs 0001 → 0008
```

## 4. Stand up the GMI box (backfill)

Full detail in `deploy/gmi/README.md`. Summary:

1. Provision a CPU GMI instance with Docker + Docker Compose.
2. Clone the repo on the box; create `deploy/gmi/.env` with the same variables
   as the repo-root `.env.example`:
   `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DATABASE_ID` (from step 1),
   `VECTORIZE_INDEX_PREFIX=wagmiphotos-bge-`, `VECTORIZE_SHARDS=3`, `GMICLOUD_API_KEY`,
   `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`, `B2_PUBLIC_URL_BASE`,
   `FLOOR_SIM_MAX=0.87`, `FLOOR_SIM_MIN=0.75`.
3. `cd deploy/gmi && docker compose up -d --build`
   (first build downloads CPU torch + the BGE model weights — one time).

The backfill loads `BAAI/bge-base-en-v1.5` in-process; there is no separate
embedding service or tunnel to stand up.

## 5. Set Worker secrets, route the custom domains, then deploy

Worker secrets (one-time, `cd projects/worker`):

```bash
npx wrangler secret put MASTER_API_KEY    # master bearer for the API
npx wrangler secret put RESEND_API_KEY    # magic-link email sending (see Accounts section)
```

**`DEV_MODE` — production must NEVER set it.** All the local-dev conveniences —
the unauthenticated dev-open API lane (requests act as `usr_dev`), the `dev_link`
echo in the login response, and console-logged magic links — now require
`DEV_MODE=true` and **fail closed without it**: a missing `MASTER_API_KEY` no
longer opens the API, and a missing `RESEND_API_KEY` no longer leaks login links.
Local dev sets it in `projects/worker/.dev.vars` (gitignored; copy
`.dev.vars.example`). Before deploying, confirm `DEV_MODE` appears nowhere in
`wrangler.toml` `[vars]` or the dashboard.

**Set `ASSET_BASE_URL`** in `wrangler.toml` `[vars]` (or the dashboard) to the
B2 friendly-URL base for the public-read bucket — the same value as the
backfill's `B2_PUBLIC_URL_BASE` (e.g.
`https://f004.backblazeb2.com/file/<bucket-name>`). Cached (`locally_cached=1`)
assets are served as `{ASSET_BASE_URL}/{asset_paths[size]}` (paths pinned in
`contract.json`); without `ASSET_BASE_URL` set, cached assets degrade to
`source_url` instead.

**Worker name:** the Worker now deploys as `wagmiphotos-worker` (`wrangler.toml`
`name`). A previously deployed `sharedcache-worker` would be a separate,
orphaned Cloudflare Worker, not an in-place upgrade — this is a fresh deploy
under the new name.

Route **both** `wagmi.photos` (site + API) and `api.wagmi.photos` (documented
API base) to this Worker in the Cloudflare dashboard, then:

```bash
npx wrangler deploy --dry-run   # confirm the output lists the RATE_LIMITER binding
npm run deploy
```

## 6. Check embedding parity, seed the pool, and tune the floor

**Drift check (required — this gates the two-runtime BGE contract).** The Worker
embeds queries with Workers AI `@cf/baai/bge-base-en-v1.5`; the backfill embeds with
local `BAAI/bge-base-en-v1.5`. They must produce vectors in the *same* space or every
match is wrong. Embed a fixture of ~10 strings with **both** — the Worker's binding
(a one-off `wrangler dev` request that returns the vector, or a temporary debug route)
and `wagmiphotos.common.bge.BgeEmbedder.from_pretrained().text_embed(...)` — and assert
pairwise cosine **≥ 0.98**. If it fails, reconcile preprocessing (an accidental query
prefix, wrong pooling, or a missing L2-normalize on one side). Code review can't verify
this — Workers AI's internal pooling vs sentence-transformers' is only checkable live.

> **Resolved 2026-07-07:** Workers AI's BGE **mean-pools** (not the CLS pooling BGE
> ships with). `BgeEmbedder.from_pretrained` now forces mean pooling to match; the
> check passes at cosine 1.0000 on all fixtures. If you swap the local embedding
> stack, re-run this check — CLS pooling drifts to ~0.95–0.98 and silently degrades
> every match.

```bash
uv run python -m wagmiphotos.backfill.seed_pd12m --limit 100   # BGE captions → wagmiphotos-bge-{0,1,2} shards
```

Then **tune** `FLOOR_SIM_MAX` / `FLOOR_SIM_MIN` against the seeded pool. BGE
text-to-text cosines run high — the current 0.87 / 0.75 were tuned 2026-07-07
against the first 1k-row seed (verbatim 1.00, paraphrase 0.87–0.91, related
~0.79, unrelated ≤0.71). Re-probe as the pool grows (coincidental closeness
creeps up with scale). Set them in the Worker `wrangler.toml` `[vars]`, the
backfill env, and `contract.json` (parity-tested defaults) together.

---

## Verify

```bash
curl https://wagmi.photos/healthz                # worker up
# open https://wagmi.photos/  → SPA loads, #/library search works
# a POST /v1/images/generations returns a nearest image or 202 pending
docker compose logs backfill --tail 20           # (on the box) polling loop ticking
```

Once rehosting has run for at least one asset, open a rehosted asset's
`thumb_url` from `GET /v1/library` directly in a browser (or `curl -I`) and
confirm it returns 200 — a 404 here means `ASSET_BASE_URL` (Worker) and
`B2_PUBLIC_URL_BASE` (backfill) don't agree, and it's a ten-second check
instead of a support ticket.

## Day 2

- Logs: `docker compose logs -f backfill`
- Update the box: `git pull && docker compose up -d --build`
- One-shot backfill for debugging: `docker compose run --rm backfill --once`

## Rollback

- Worker: `npx wrangler rollback` (or redeploy a prior commit).
- Migrations are forward-only — do not delete D1 data to "undo"; restore from a
  D1 export if needed.

---

## Still open (do later)

Everything is code-complete and green (both test suites pass offline); these are
the loose ends to pick up when you resume. Full backlog + design trail: root
`HANDOFF.md` and `docs/HANDOFF-2026-07-07.md`.

### BGE embeddings — Task 6 ✅ DONE 2026-07-07 (except the GMI box)
Shards created (`wagmiphotos-bge-0/1/2`), drift check PASSED at cosine 1.0000
(after forcing mean pooling — see the Resolved note in step 6), 1k PD12M rows
seeded from the local parquet download (`seed_pd12m --metadata-dir`, shard
balance 333/343/324), floors tuned 0.87/0.75 and deployed. The backfill image
`docker build` with `--extra model` is now verified locally (2026-07-08): builds
clean, runs as non-root `uid=10001`, and loads BGE + embeds a 768-d vector with
no model-cache permission errors. That build first surfaced (and this session
fixed) torch resolving to the full CUDA stack — `torch` is now pinned to the
PyTorch CPU wheel index, cutting the image from 10.8GB to 2.71GB.

### During / right after deploy
- **Re-probe the floor at scale**: 0.87/0.75 were tuned against the 1k seed;
  coincidental similarity creeps up as the pool grows toward 12.5M — re-run the
  probe after each big seed batch.
- **Build-verify the non-root images** — ✅ DONE 2026-07-08. Built locally
  (`docker build -f projects/backfill/Dockerfile`, image 2.71GB after the CPU
  torch pin): runs as `uid=10001(appuser)`, and BGE loads + embeds a 768-d
  vector via `uv run --no-sync` with no model-cache permission errors. Still
  worth a smoke run on the box itself via `cd deploy/gmi && docker compose up
  -d --build` to confirm the compose env_file + restart policy under real infra.

### Deferred hardening (none blocking; triage before real traffic)
- **Backfill rehost:** 25 MB size cap is in; add a **host allowlist** once
  `source_url` can be user-influenced (today it's trusted PD12M seed only).
- **Worker:** add edge caching on the `/v1/library*` endpoints.
- **Tooling:** dev-only `npm audit` findings in wrangler/vitest/esbuild
  transitive deps.

### Follow-ups worth scheduling
- **Real-D1 (miniflare) integration harness** — retires the "fakeDb records SQL
  but never executes it" blind spot.
- **Prompt→embedding caching in the Worker** — cuts most Workers AI (BGE) calls
  off the hot path (repeat prompts are the whole premise).
- **SPA smoke test** — a tiny Playwright test for the hit / approximate /
  pending render states (currently verified by inspection only).

## Accounts + magic-link login

Passwordless email-magic-link auth gates the product (playground/library/account
+ the API). Login tokens are nonce-bound (migration `0005`), so a stolen or
prefetched verify link alone can't log anyone in. Deploy steps:

1. **Apply migrations to remote D1 BEFORE deploying the Worker** — covered by
   step 3 above (note `0004`'s breaking anonymous-key wipe and `0005` voiding
   outstanding magic links).
2. **Set the Resend secret + sender:** `npx wrangler secret put RESEND_API_KEY`;
   confirm `EMAIL_FROM` in `wrangler.toml` (`noreply@mail.suppers.ai`) and **verify that
   sending domain in Resend**. With `RESEND_API_KEY` unset (and no `DEV_MODE`, which
   prod must never set — see step 5) login fails closed: no email is sent and no
   link is logged or returned. Never deploy prod without the Resend secret.
3. **Confirm** `wrangler deploy --dry-run` bundles; after deploy, a logged-out visit
   to `#/playground` should redirect to `#/login`, and a real email should receive a
   working magic link.

### Security fast-follows (not blocking; do before real traffic)
- **Token/session GC:** expired `login_tokens`/`sessions` rows are now purged
  opportunistically during login requests; a scheduled GC (cron trigger) remains
  optional hardening for long idle periods.
