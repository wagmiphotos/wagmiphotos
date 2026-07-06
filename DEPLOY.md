# DEPLOY — going live

Ordered runbook for the first production deploy. Everything is verified offline
with fakes; nothing below has run against live infra yet. Run the steps **in
order** — several have hard dependencies (noted inline).

Prereqs: a Cloudflare account, a Backblaze B2 bucket, a GMI Cloud (CPU) box with
Docker, and a GMI Cloud generation API key. All commands are run from the repo
root unless a `cd` is shown.

---

## 0. Authenticate

```bash
cd projects/worker && npx wrangler login
```

## 1. Create D1 and wire its id

D1 does **not** exist yet — `wrangler.toml` still has a placeholder id.

```bash
npx wrangler d1 create sharedcache        # copy the database_id it prints
```

Edit `projects/worker/wrangler.toml` → replace `REPLACE_WITH_D1_DATABASE_ID`
(line ~9) with the id. (Ask Claude to make this edit if you paste the id.)

## 2. Create the Vectorize index

```bash
npx wrangler vectorize create wagmiphotos-bge --dimensions=768 --metric=cosine
```

## 3. Apply D1 migrations remotely — **BEFORE any deploy**

Migrations `0002` (`queries.generate`, backfill demand tracking) and `0003`
(assets browse index) must be live first. Deploying the Worker ahead of them
breaks demand tracking and **hard-errors the Python backfill**.

```bash
npx wrangler d1 migrations apply sharedcache --remote   # runs 0001 → 0002 → 0003
```

## 4. Stand up the GMI box (backfill)

Full detail in `deploy/gmi/README.md`. Summary:

1. Provision a CPU GMI instance with Docker + Docker Compose.
2. Clone the repo on the box; create `deploy/gmi/.env` with the same variables
   as the repo-root `.env.example`:
   `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DATABASE_ID` (from step 1),
   `VECTORIZE_INDEX_NAME=wagmiphotos-bge`, `GMICLOUD_API_KEY`,
   `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`, `B2_PUBLIC_URL_BASE`,
   `FLOOR_SIM_MAX=0.90`, `FLOOR_SIM_MIN=0.72`.
3. `cd deploy/gmi && docker compose up -d --build`
   (first build downloads CPU torch + the BGE model weights — one time).

The backfill loads `BAAI/bge-base-en-v1.5` in-process; there is no separate
embedding service or tunnel to stand up.

## 5. Route the custom domains, then deploy

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
and `sharedcache.common.bge.BgeEmbedder.from_pretrained().text_embed(...)` — and assert
pairwise cosine **≥ 0.98**. If it fails, reconcile preprocessing (an accidental query
prefix, wrong pooling, or a missing L2-normalize on one side). Code review can't verify
this — Workers AI's internal pooling vs sentence-transformers' is only checkable live.

```bash
uv run python -m sharedcache.backfill.seed_pd12m --limit 100   # BGE captions → wagmiphotos-bge
```

Then **tune** `FLOOR_SIM_MAX` / `FLOOR_SIM_MIN` against the seeded pool. BGE
text-to-text cosines run high (typically ~0.7–0.95) — the defaults (0.90 / 0.72)
are a starting guess, not calibrated. Set them in both the Worker `wrangler.toml`
`[vars]` and the backfill env (`sharedcache.common.config`).

---

## Verify

```bash
curl https://wagmi.photos/healthz                # worker up
# open https://wagmi.photos/  → SPA loads, #/library search works
# a POST /v1/images/generations returns a nearest image or 202 pending
docker compose logs backfill --tail 20           # (on the box) polling loop ticking
```

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

Everything is code-complete and green (Python 46 / Worker 113); these are the
loose ends to pick up when you resume. Full backlog + design trail: root
`HANDOFF.md` and `docs/HANDOFF-2026-07-04.md`.

### BGE embeddings — provision at deploy (Task 6, not yet run — needs live CF + GMI)
The BGE search layer is code-complete but has never touched live infra. At deploy:
create the `wagmiphotos-bge` index (step 2), run the **embedding drift check**
(Worker Workers-AI BGE vs local BGE, cosine ≥ 0.98 — step 6), seed the pool, then
tune the floor. See `docs/superpowers/plans/2026-07-06-bge-edge-embeddings.md` Task 6.
Also do a real `docker build` of the backfill image with `--extra model` (pulls CPU
torch + BGE weights) — so far only verified via `uv sync --dry-run`.

### During / right after deploy
- **Tune the floor** (step 6): set `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN` from the real
  seeded pool (BGE text-to-text cosines run high, ~0.7–0.95), not the 0.90/0.72 guess.
- **Build-verify the non-root images** — they pass `docker build --check` but
  were never built here (torch/BGE weights). On the box:
  `cd deploy/gmi && docker compose up -d --build`, then
  `docker compose exec backfill id` should print a non-root uid, and
  `docker compose logs backfill` should show BGE weights loaded (no permission
  errors on the model cache), using `uv run --no-sync`.

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
- **Branding:** the SPA reads `WagmiPhotos` / `wagmi.photos`; the repo/project
  is `SharedCache`. Pick one and reconcile (see `HANDOFF.md` §2).

## Accounts + magic-link login (feat/accounts-magic-link-auth)

New passwordless email-magic-link auth gates the product (playground/library/account
+ the API). Deploy steps:

1. **Apply migration `0004` to remote D1 BEFORE deploying the Worker:**
   `cd projects/worker && npx wrangler d1 migrations apply sharedcache`
   ⚠️ **Breaking change:** `0004` runs `DELETE FROM api_keys WHERE user_id IS NULL`,
   wiping **all pre-existing anonymous API keys**. Any live SDK integration using a
   self-minted key stops working and must sign up + reissue a key from the dashboard.
2. **Set the Resend secret + sender:** `npx wrangler secret put RESEND_API_KEY`;
   confirm `EMAIL_FROM` in `wrangler.toml` (`login@wagmi.photos`) and **verify that
   sending domain in Resend**. With `RESEND_API_KEY` unset the Worker runs in dev mode
   (magic link logged/returned, not emailed) — never deploy prod without it.
3. **Confirm** `wrangler deploy --dry-run` bundles; after deploy, a logged-out visit
   to `#/playground` should redirect to `#/login`, and a real email should receive a
   working magic link.

### Security fast-follows (from final review — not blocking merge, do before real traffic)
- **Login session-fixation:** the GET `/v1/auth/verify` sets the session cookie, and
  `SameSite=Lax` gates cookie *send*, not *set* — an attacker can request a link to
  their own inbox and induce a victim's browser to load the verify URL, logging the
  victim into the attacker's account. Bind the login token to a nonce cookie set at
  `/v1/auth/login` (or a POST-confirm interstitial).
- **Email-scanner prefetch** (Safe Links/Proofpoint) GETs the link and consumes the
  single-use token before the user clicks. A POST-confirm interstitial fixes both this
  and the fixation vector in one change.
- **Token/session GC:** `login_tokens`/`sessions` are never purged — add an
  expired-row cleanup before the tables grow unbounded.
