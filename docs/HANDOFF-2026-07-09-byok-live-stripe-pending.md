# Handoff — BYOK live, Stripe go-live pending (2026-07-09)

_BYOK (bring-your-own-key generation) is **fully live in production** as of today.
The same deploy also shipped the Stripe billing code, but the **live Stripe config
is still not done** — the Upgrade button errors until it is. This doc is the
resume-here for the remaining work, in priority order._

Supersedes the top-level banner of `docs/HANDOFF-2026-07-08-stripe-billing.md`
(its §2 production steps are partially done — see below; its §1 local-testing
recipes remain valid).

## What went live today (all verified by probes)

- **BYOK end-to-end** (spec `docs/superpowers/specs/2026-07-09-byok-self-serve-generation-design.md`,
  merged c6d0b94..6e976f0): any signed-in user stores one OpenAI/GMI key
  (AES-256-GCM under `BYOK_KEK`), below-tolerance requests generate fresh
  in-request with their key (`result:"generated"`), monthly cap + $-estimate
  meter on the account card, images join the shared library (R2 original →
  demand-rehost derives B2 sizes). `assets.created_by` audit column records the
  generating user (migration 0014; never selected on public reads).
- **Prod setup done**: migrations **0012–0014** applied remote; R2 bucket
  `wagmiphotos-byok-originals` + custom domain **byok.wagmi.photos** (active,
  TLS ≥1.2, zone 9ee1f0a631d201a3c5191dfb8d6076d3); secrets `BYOK_KEK` +
  `OPENAI_API_KEY` set; worker deployed (latest version `06ddf6ce`).
- **⚠️ `BYOK_KEK` has NO backup copy** (deliberate). If it is ever rotated or
  lost, stored user keys become undecryptable — requests degrade gracefully and,
  since 6e976f0, the key auto-disables with `last_error="decrypt_failed"` and
  the account card tells the user to re-enter it. Rotate only deliberately.
- Docs pages now document `result:"generated"`, the `shared_cache.byok` shapes,
  `400 content_policy`, and the corrected `cache_tolerance` FAQ.

## Also shipped later the same day (homepage + asset origin)

- **`cdn.wagmi.photos` is the public asset origin** — clean URLs
  `https://cdn.wagmi.photos/assets/{id}/<size>.webp`. ⚠️ **These only work
  through a Cloudflare Transform Rule** (host `cdn.wagmi.photos`, path
  `/assets/*` → prepend `/file/wagmi-photos-library`) plus the proxied DNS
  record and cache rule, all dashboard-side. Delete that rule and every
  derived asset URL breaks. `ASSET_BASE_URL` (wrangler.toml) ==
  `B2_PUBLIC_URL_BASE` (deploy/gmi/.env) == `https://cdn.wagmi.photos`.
  Discovery: the previously documented `images.wagmi.photos` never existed in
  DNS (unnoticed because the backfill box has never rehosted anything), so
  nothing was migrated. No real object serves yet — the wiring proof is B2's
  `not_found` JSON at the clean path; the first rehost makes it real.
- **Homepage pass** (specs `2026-07-09-homepage-compare-move-api-cards` +
  `2026-07-09-cdn-hostname-open-license-band`): "Faster. Cheaper. Better."
  moved below "What you get back"; the OpenAI-compatible section is two
  static stacked code cards (tabs + red scribble removed, no height jump)
  with the floating callout showing the full real response JSON; example
  URLs use the real cdn shape; the CTA band is now the open-license
  positioning ("Openly licensed. Close enough, on purpose.").

## 1. Stripe go-live (dashboard work — blocks all revenue)

Status vs `HANDOFF-2026-07-08-stripe-billing.md` §2: step 1 (migration 0012)
**DONE**; step 4 (RATE_LIMITER_PAID namespace) **DONE** (deployed clean); step 7
(deploy) **DONE** — the billing code is live now. Until the rest is configured,
"Upgrade to Unlimited" shows "Could not start checkout" and nobody can subscribe
or mint paid API keys. Remaining:

1. **Live Product + Price** (Stripe dashboard, live mode): recurring,
   `unit_amount=2400`, `currency=usd`, `interval=year`. Note the live `price_…`.
2. **Secrets:** `npx wrangler secret put STRIPE_SECRET_KEY` (live `sk_live_…`)
   and `STRIPE_WEBHOOK_SECRET` (from step 3's endpoint).
3. **Webhook endpoint** (dashboard → Developers → Webhooks) →
   `https://api.wagmi.photos/v1/stripe/webhook`, events:
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`.
   Pin the endpoint's API version (2024-ish) or the "renews `<date>`" line may be
   blank (entitlement unaffected).
4. **Enable the live Customer Portal** (Settings → Billing → Customer portal).
5. **`wrangler.toml`**: replace `STRIPE_PRICE_ID = "price_REPLACE_ME"` with the
   live id, then `cd projects/worker && npm run deploy`.
6. Verify per the 2026-07-08 handoff's "Post-deploy verification".

## 2. BYOK live verification (human, browser — ~5 minutes)

Everything is configured; nobody has yet exercised the full path against prod:

- Log in at wagmi.photos → **Account** → add a real OpenAI key, cap **2** →
  playground: run an obscure below-floor prompt → expect the ✨ **generated**
  badge and meter 1/2 → two more runs → **cap_reached** notice → image visible
  in the library → delete the key.
- **Repeat once with a GMI Cloud key** — this is the one provider path no test
  could exercise: it verifies GMI's key-validation ping against the live API
  (`GET …/requestqueue/apikey/requests`). If a bad GMI key were accepted, it
  auto-disables on first use (graceful), but confirm the happy path.
- Optional: have the assistant run `wrangler tail` in the background during the
  click-through for the worker's-eye view.

## 3. GMI backfill box (pre-existing gap, unchanged)

Still the missing organ (root `HANDOFF.md` "Next steps" §1, `DEPLOY.md` step 4):
queued demand doesn't generate and nothing rehosts until it runs — which also
means **BYOK originals serve from byok.wagmi.photos indefinitely** (fine, but
thumb/medium derivations into B2 only happen once the box is up).

## 4. Deferred minors (non-blocking, from the BYOK review ledger)

Done since the review: KEK-rotation UX + public docs (6e976f0), created_by
audit (9f3ec3e). Still parked (see `.superpowers/sdd/progress.md` for the full
per-task list):

- `PUT /v1/byok` returns `key_rejected` when the provider is merely unreachable
  (transient network error looks like a bad key to the user).
- A moderation outage surfaces as `provider_error` ("your key failed") — a
  neutral status/copy would be more honest.
- `est_spend_usd` in the generation response is unrounded float accumulation
  (`/v1/me` rounds to cents; bearer consumers may see `0.16000000000000003`).
- The playground's telemetry counts `generated` results in the "misses" bucket;
  account meter doesn't live-refresh after a playground generation (matches the
  pre-existing plan-card staleness pattern).
- Test-coverage nits: PATCH/DELETE 401s, validate()-throws path, post-read
  byte-cap branch, insertGenerated-throws refund.

## Ground truth

- `main` pushed through `14c30ec` (+ this handoff commit); deployed worker
  version `77f274d0` matches it.
- Suites: worker 255/255 + `tsc --noEmit` clean; Python 105/105.
- Wrangler secrets now: `BYOK_KEK`, `MASTER_API_KEY`, `OPENAI_API_KEY`,
  `RESEND_API_KEY` (Stripe pair still missing — see §1).
- Housekeeping: a stray `wrangler dev` from Jul 8 (PID 2106559) may still be
  running on the dev machine; kill it manually.
