# Handoff — Stripe billing (2026-07-08)

_Stripe annual-subscription billing + paid-API gating is **merged to `main`** and
locally verified end-to-end, but **not yet configured on production**. This doc is
the resume-here for (1) doing more local testing and (2) turning it on in prod._

Spec: `docs/superpowers/specs/2026-07-08-stripe-subscriptions-paid-api-design.md`
Plan: `docs/superpowers/plans/2026-07-08-stripe-subscriptions-paid-api.md`
Runbook: `DEPLOY.md` → "Stripe billing" section.

## What shipped (on `main`)

- **$24/yr annual subscription** via Stripe-hosted **Checkout** + **Customer Portal**
  (redirect flow; SDK-free `fetch` to `api.stripe.com`; **publishable key unused**).
- **Gating (`src/index.ts` + `src/session.ts`):** the **bearer-key API is paid-only** —
  `POST /v1/keys/generate` and bearer `POST /v1/images/generations` return **402**
  ("Unlimited plan required") for a non-subscribed owner. The **session-cookie
  playground stays free**. master/dev bypass. Paid principals use the higher
  `RATE_LIMITER_PAID` tier (120/min) vs the free `RATE_LIMITER` (10/min).
- **Entitlement (`migration 0012`, `src/entitlement.ts`):** on the `users` row —
  `plan_status`, `stripe_customer_id`, `stripe_subscription_id`,
  `plan_current_period_end`. Rule: `isPaid = plan_status IN ('active','trialing')`.
- **Webhook (`src/stripe-routes.ts`, `src/stripe.ts`):** `POST /v1/stripe/webhook` —
  HMAC-SHA256 verify over the **raw body** before parse (bad sig → 400, no write);
  handles `checkout.session.completed` (link customer↔user) +
  `customer.subscription.created|updated|deleted` (set/clear status). Idempotent
  upserts keyed by `stripe_customer_id`.
- **Frontend (`public/index.html`):** account **Plan card** (Upgrade / Manage billing),
  "Create API key" gated for free users, `?checkout=success` re-fetches `/v1/me`
  (entitlement comes from the webhook, not the redirect).
- **Tests:** 189 passing, `tsc` clean.

Reviewed clean at every task + a final whole-branch review (verdict: ready to merge).

---

## 1. More local testing

### One-command smoke test (recommended)

`projects/worker/scripts/local-billing-smoke.py` drives the whole lifecycle
(free→402 → checkout creates a real sandbox customer → bad-sig→400 → signed
`subscription.created`→Unlimited → paid keygen→200 + gate passes → `subscription.deleted`→revoked→402 → unknown-event→200) and exits non-zero on any failure. It **self-signs the webhook events** with the same HMAC scheme Stripe uses, so it needs no Stripe CLI.

```bash
cd projects/worker
# .dev.vars must have: DEV_MODE=true, PUBLIC_SITE_URL=http://localhost:8787,
#   STRIPE_SECRET_KEY=sk_test_…, STRIPE_PRICE_ID=price_…, STRIPE_WEBHOOK_SECRET=<any value locally>
npx wrangler d1 migrations apply wagmiphotos --local        # once; applies through 0012
npx wrangler dev --local --port 8787 --ip 127.0.0.1 &       # leave running
python3 scripts/local-billing-smoke.py                      # → "16/16 checks passed", exit 0
# optional: EMAIL=someone-new@example.com  BASE=http://localhost:8787  as overrides
```

Creating the sandbox Price (only needed once; writes `STRIPE_PRICE_ID` into `.dev.vars`):

```bash
SK=$(grep '^STRIPE_SECRET_KEY=' .dev.vars | cut -d= -f2-)
curl -s https://api.stripe.com/v1/prices -u "$SK:" \
  -d unit_amount=2400 -d currency=usd -d "recurring[interval]=year" \
  -d "product_data[name]=wagmi.photos Unlimited"          # copy the returned "id": "price_…"
```

**Offline caveat:** image generation itself 500s locally (no Vectorize / Workers AI).
That's why a *paid* key hitting `/v1/images/generations` returns **500, not 402** — the
gate passed and generation then failed on the missing binding. The smoke test asserts
exactly that ("not 401/402"). To exercise real generation you need deployed infra.

### Real browser + real Stripe events (optional, higher fidelity)

The **Stripe CLI is not installed** on the current dev machine — install it to get the
real Stripe→localhost webhook tunnel and a real hosted-checkout completion:

```bash
brew install stripe/stripe-cli/stripe    # or see https://stripe.com/docs/stripe-cli
stripe login
stripe listen --forward-to http://localhost:8787/v1/stripe/webhook   # prints whsec_… → put in .dev.vars, restart wrangler
```

Then: dev-login in the browser (`#/login` → dev link), `#/account` → **Upgrade**, complete
checkout with card **`4242 4242 4242 4242`** (any future expiry / any CVC / any ZIP). The
real `customer.subscription.created` flows through `stripe listen` → your webhook → the
account flips to Unlimited. Cancel in the Portal to watch it revoke. Use the
`stripe:test-cards` skill for decline/3DS/insufficient-funds scenarios (e.g.
`4000 0000 0000 0002` = generic decline).

---

## 2. Production Stripe setup (not done yet)

> **Status update 2026-07-09:** steps **1** (migration 0012 applied remote), **4**
> (RATE_LIMITER_PAID deployed) and **7** (worker deployed — it rode the BYOK deploy) are
> **DONE**. Steps **2, 3, 5, 6** (live Price, secrets + `STRIPE_PRICE_ID`, webhook endpoint,
> Customer Portal) remain — see `docs/HANDOFF-2026-07-09-byok-live-stripe-pending.md` §1.
> Until then the deployed Upgrade button errors and nobody can subscribe.

All of this is in `DEPLOY.md` → "Stripe billing"; summarized here in order.

1. **Apply the migration to prod D1:**
   `npx wrangler d1 migrations apply wagmiphotos --remote`  (adds the `0012` columns).
2. **Create the live Product + Price** (Stripe dashboard in **live mode**, or the curl above
   with the **live** secret key): recurring, `unit_amount=2400`, `currency=usd`,
   `interval=year`. Note the live `price_…`.
3. **Set config on the worker:**
   - `npx wrangler secret put STRIPE_SECRET_KEY`  → the **live** `sk_live_…`
   - `npx wrangler secret put STRIPE_WEBHOOK_SECRET`  → the signing secret from step 5
   - In `wrangler.toml` `[vars]`, set `STRIPE_PRICE_ID` to the **live** price id (replace
     the `price_REPLACE_ME` placeholder).
4. **Give `RATE_LIMITER_PAID` a real namespace.** It's already declared in `wrangler.toml`
   (`namespace_id = "1002"`, 120/60s) — confirm that namespace id is unique for the account
   and tune the limit if desired.
5. **Create the webhook endpoint** (dashboard → Developers → Webhooks) pointing at
   `https://api.wagmi.photos/v1/stripe/webhook`, subscribed to:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy its **signing
   secret** into `STRIPE_WEBHOOK_SECRET` (step 3).
   - **Pin the endpoint's API version** to one where the subscription object still carries a
     top-level `current_period_end` (2024-ish), or the account "renews `<date>`" line will be
     blank. Entitlement itself is unaffected either way. (See follow-up (b).)
6. **Enable the live Customer Portal** (dashboard → Settings → Billing → Customer portal),
   or `/v1/billing/portal` 404s / errors.
7. **Deploy:** `cd projects/worker && npm run deploy` (or per `DEPLOY.md`).

### Post-deploy verification (prod)

- `stripe listen` isn't needed in prod — the dashboard endpoint delivers events. Use the
  dashboard's "Send test webhook" or complete a real `4242` checkout in **test mode against
  a test-mode deploy** first if you want a dry run.
- Real end-to-end: subscribe a throwaway account, confirm `/v1/me` shows `plan.active:true`,
  mint a key, call `POST /v1/images/generations` (should now actually generate against live
  infra), then cancel in the Portal and confirm the key 402s.
- Watch the worker logs for `stripe … <status>` errors (secret/price misconfig surfaces as a
  generic 5xx to the client with detail in the log only).

---

## 3. Known follow-ups (deferred, non-blocking — from the final review)

Documented in the spec's "Known follow-ups" section:

- **(a) Concurrent-checkout customer-link race.** Two simultaneous checkout initiations for a
  not-yet-linked user can leave the user row pointing at the *other* customer id, so a
  `subscription.created` for the completed one updates 0 rows and the user is briefly stranded
  as free. Low probability, largely self-repairing via the `link` event. Fix when convenient:
  have the `link` reducer also persist status (expand the session's subscription), or fall
  back to `client_reference_id` on a missed customer lookup, or 500-on-0-rows to force retry.
- **(b) `current_period_end` on newer Stripe API versions** — moved onto `items.data[]`; pin
  the webhook API version (deploy step 5) or read `items.data[0].current_period_end` if the
  renewal-date display matters. Cosmetic only.
- **(c) Cheap nits:** add webhook tests for unknown-event→200 / apply-throws→500; a
  `stripePost` fast-fail on missing `STRIPE_SECRET_KEY`; minor DRY (a `paymentRequired()`
  helper, a shared `site` const); portal `return_url` doesn't re-fetch `/v1/me`.

## Sandbox artifacts created during local testing (safe to delete)

- Product "wagmi.photos Unlimited" + Price `price_1Tqs1Y8DG1FnJpBRDkXeEXYW` (test mode).
- A few test customers (`cus_…`) from smoke runs. All test-mode; ignore or delete.
