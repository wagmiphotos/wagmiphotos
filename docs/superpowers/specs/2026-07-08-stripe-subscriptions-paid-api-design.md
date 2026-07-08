# Stripe subscriptions + paid API gating — design

**Date:** 2026-07-08
**Status:** Approved

## Purpose

Turn the advertised **Unlimited — $24/yr** plan into a real, enforced product.
Today the pricing page markets a paid tier, but the "Go Unlimited" button just links
to `#/account`; there is **no payment path and no entitlement** — every logged-in user
can mint API keys and call `POST /v1/images/generations` at 10 req/min. Billing/plan
enforcement was explicitly deferred as an out-of-scope follow-up in the accounts build
(`2026-07-06-accounts-magic-link-auth-design.md`).

This build adds a recurring **annual Stripe subscription** and gates the programmatic
API behind it, while keeping the free site playground exactly as it is.

## Scope

- **Billing model:** a single recurring **annual subscription** priced at **$24/yr**,
  auto-renewing, cancellable via the Stripe Customer Portal ("billed annually · cancel
  anytime"). One plan only.
- **Checkout:** Stripe-hosted Checkout (`mode=subscription`) via redirect. No card data
  touches the Worker (PCI stays with Stripe). No Stripe.js / Elements — the sandbox
  **publishable key is not used** in this build.
- **Entitlement enforcement (the free/paid seam):**
  - **Free** (logged in, no active subscription): full site **playground** — the
    session-authed closest-match search — unchanged, at the existing 10/min limit.
    **Cannot mint API keys; cannot call the API with a bearer key.**
  - **Unlimited** (active subscription): a commercial-license entitlement, **can mint
    keys and use the bearer API**, and a **higher generation rate limit**.
- **Stripe integration style:** SDK-free — direct `fetch` calls to `api.stripe.com`,
  matching how Resend, the GitHub API, and OpenAI moderation are already called. No new
  npm runtime dependency.
- **Tooling:** the Stripe Claude Code plugin (`stripe:stripe-best-practices`,
  `stripe:test-cards`, `stripe:explain-error` skills + Stripe MCP) is used at
  development/test time only; it is not a runtime dependency.

### Out of scope (explicit non-goals)

Multiple plans/tiers, monthly billing, proration or plan changes, teams/seats, coupons,
Stripe Tax, refunds/dunning UI (Stripe's own emails handle failed payments), invoice
history UI, server-side BYOK changes, and any change to the backfill/generation pipeline.

## The free/paid seam (why this boundary)

`resolveApiPrincipal` (`src/session.ts`) already distinguishes two caller types:

1. A **bearer key** (`Authorization: Bearer sc-…`) → the programmatic API.
2. A **session cookie** (`wagmi_session`) → the logged-in browser (the SPA playground,
   which posts to `/v1/images/generations` with no bearer, so it resolves via session).

That pre-existing split *is* the free/paid line, and it matches the pricing copy exactly:
Free advertises "unlimited search & instant closest-match" with "Unlimited rate + API
access" crossed out; Unlimited advertises "OpenAI-compatible API access, no rate limits,
commercial-use license". So **bearer-key access is the paid surface; the session
playground stays free.**

Master key (`MASTER_API_KEY`) and the dev principal (`DEV_MODE`) bypass all gating,
unchanged.

## Data model — D1 migration `0012`

(Latest existing migration is `0011`; this is the next one.)

```sql
-- Stripe subscription state, one row per user. plan_status mirrors the Stripe
-- subscription status; NULL means the user has never subscribed (free tier).
ALTER TABLE users ADD COLUMN stripe_customer_id      TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id  TEXT;
ALTER TABLE users ADD COLUMN plan_status             TEXT;   -- 'active'|'trialing'|'past_due'|'canceled'|... ; NULL => free
ALTER TABLE users ADD COLUMN plan_current_period_end TEXT;   -- ISO8601; for display + grace, informational

-- Webhooks resolve the user by their Stripe customer id.
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);
```

**Derived entitlement** (single source of truth, in code, no separate `plan` column):

```
isPaid(user) = user.plan_status IN ('active', 'trialing')
```

We trust Stripe to flip `plan_status` to a non-active value at the right time
(`past_due`, `canceled`, or the subscription being deleted). `plan_current_period_end`
is stored for display ("renews / access until …") and is not itself used to gate.

Migrations that add columns to a table exposed through a view must recreate the view —
but `users` is queried directly (no `live_users` view), so no view recreation is needed
here (unlike the `assets`/`live_assets` pattern).

## Worker — new module `src/stripe.ts`

A thin, dependency-injected Stripe client plus pure helpers, mirroring the `email` /
`embedder` service pattern so it is fully fakeable in tests.

### Pure helpers (unit-tested directly, no network)

- `formEncode(obj)` — encodes nested params to `application/x-www-form-urlencoded`
  (e.g. `line_items[0][price]=…`), the encoding the Stripe REST API expects.
- `verifyStripeSignature({ payload, header, secret, toleranceSec, now })` — verifies the
  `Stripe-Signature` header:
  - parse `t=<ts>,v1=<sig>` (ignore other schemes),
  - `signedPayload = "${t}.${payload}"`, `expected = HMAC_SHA256(signedPayload, secret)`
    (hex) via WebCrypto (`crypto.subtle.importKey`/`sign`),
  - constant-time compare `v1` vs `expected` (reuse `constantTimeEqual`),
  - reject if `|now - t| > toleranceSec` (default 300s).
  - **Uses the raw request body** (`await request.text()`), never the re-serialized JSON.
- `entitlementFromEvent(event)` — pure reducer mapping a parsed Stripe event to the
  fields to write on the user:
  - `checkout.session.completed` → `{ customerId, subscriptionId }` (+ `userId` from
    `client_reference_id` as a defensive fallback link),
  - `customer.subscription.created` / `.updated` → `{ customerId, subscriptionId,
    plan_status: sub.status, plan_current_period_end }`,
  - `customer.subscription.deleted` → `{ customerId, plan_status: 'canceled' }`,
  - other event types → `null` (ignored, still 200 so Stripe stops retrying).

### Injected provider `makeStripe(env)` (network; faked in tests)

- `ensureCustomer(user)` → returns `user.stripe_customer_id`, or `POST /v1/customers`
  (with `email` and `metadata[user_id]`), persists it on the user, and returns the id.
- `createCheckoutSession({ customerId, userId })` → `POST /v1/checkout/sessions` with
  `mode=subscription`, `line_items[0][price]=STRIPE_PRICE_ID`, `line_items[0][quantity]=1`,
  `customer=<id>`, `client_reference_id=<userId>`, `success_url`, `cancel_url`; returns
  `{ url }`.
- `createPortalSession({ customerId })` → `POST /v1/billing_portal/sessions` with a
  `return_url`; returns `{ url }`.

All calls use `Authorization: Bearer ${STRIPE_SECRET_KEY}`. Non-2xx Stripe responses are
logged (full detail server-side) and surfaced to the client as a generic 502.

## Worker — routes (`src/index.ts`) + handlers (`src/stripe-routes.ts`)

| Route | Method | Auth | Behavior |
|---|---|---|---|
| `/v1/billing/checkout` | POST | session | `ensureCustomer` → `createCheckoutSession` → `{ url }`. 401 if not logged in. |
| `/v1/billing/portal` | POST | session | Requires an existing `stripe_customer_id` (else 404 "no billing account"); `createPortalSession` → `{ url }`. |
| `/v1/stripe/webhook` | POST | signature | Read raw body, `verifyStripeSignature` (400 on failure), parse, `entitlementFromEvent`, write to the user (resolve by `stripe_customer_id`, or by `client_reference_id` on the checkout event), always 200 on success. |

Success/cancel URLs point back at the SPA:
`success_url = ${PUBLIC_SITE_URL}/#/account?checkout=success`,
`cancel_url  = ${PUBLIC_SITE_URL}/#/pricing?checkout=cancel`,
`portal return_url = ${PUBLIC_SITE_URL}/#/account`.

**Idempotency:** all webhook writes are upserts on the user row keyed by customer id, so
Stripe's at-least-once redelivery is safe. No dedup table needed.

## Worker — gating changes

New `UserStore` methods: `getByStripeCustomerId(id)`, and
`setSubscription(userId, { customerId, subscriptionId, plan_status, plan_current_period_end })`
(partial update; only provided fields are written). `KeyStore` gains no change; the paid
check reads the owning user.

Enforcement points (all return **402 Payment Required** with
`{ error: "Unlimited plan required", upgrade_url }` when blocked):

1. **`POST /v1/keys/generate`** — after resolving the session, load the user and require
   `isPaid`. Free users cannot mint keys.
2. **`POST /v1/images/generations`** — after `resolveApiPrincipal`:
   - **bearer-key principal** → load the key's owning user; require `isPaid`. A lapsed
     subscription makes previously-minted keys stop working.
   - **session principal** (playground) → allowed (free closest-match), no paid check.
   - **master / dev principal** → allowed, unchanged.
3. **Rate limit tiering** — a second unsafe ratelimit binding `RATE_LIMITER_PAID` (higher
   limit; exact number tunable, e.g. 120/60s) is used for paid bearer traffic; the
   existing `RATE_LIMITER` (10/60s) continues to cover free/session traffic and keygen.
   Selection: paid principal → `RATE_LIMITER_PAID`, otherwise `RATE_LIMITER`.

`/v1/library` and `/v1/library/:id/download` remain login-gated only (unchanged) — the
library is part of the free experience.

## Frontend (`public/index.html`)

1. **`GET /v1/me`** response gains:
   ```json
   "plan": { "active": true, "status": "active", "current_period_end": "2027-07-08" }
   ```
   (`handleMe` in `auth-routes.ts` reads the new user columns.)
2. **Account page — new "Plan" card** above Credentials:
   - Free → copy + **"Upgrade to Unlimited — $24/yr"** button → `POST /v1/billing/checkout`
     → `location = url`.
   - Unlimited → "Unlimited — renews `<date>`" + **"Manage billing"** → `POST
     /v1/billing/portal` → `location = url`.
3. **Gate "Create API key"**: for free users the button is disabled with an inline
   "Upgrade to Unlimited to create API keys" hint linking to the Plan card.
4. **Return handling**: on `#/account` show, if `?checkout=success` → refresh `/v1/me`
   and toast "You're on Unlimited 🎉"; if `?checkout=cancel` on `#/pricing` → toast
   "Checkout canceled." (Entitlement itself is set by the webhook, not the redirect;
   the redirect only triggers a refresh.)
5. The pricing **"Go Unlimited — $24/yr"** button keeps pointing at `#/account` (where
   the upgrade lives). No change to the pricing cards' copy.

## Config / secrets

- `wrangler secret put STRIPE_SECRET_KEY` — sandbox `sk_test_…` (prod `sk_live_…`).
- `wrangler secret put STRIPE_WEBHOOK_SECRET` — `whsec_…`. **Locally** this is the secret
  printed by `stripe listen`; **in production** it is the signing secret of the dashboard
  webhook endpoint. Stored in `.dev.vars` for local dev.
- `[vars] STRIPE_PRICE_ID` — the recurring annual Price id (not sensitive). Also in
  `.dev.vars` for local dev.
- New `Env` fields: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`.
- The **publishable key is intentionally unused** (hosted Checkout only). If Elements is
  adopted later it would be added as a plain `[vars]` value.
- **Stripe objects to create once** (sandbox, via Stripe MCP or dashboard): a Product
  "wagmi.photos Unlimited" and a recurring Price — `unit_amount=2400`, `currency=usd`,
  `recurring[interval]=year`. Copy the Price id into `STRIPE_PRICE_ID`. Enable the
  Customer Portal in the sandbox (Settings → Billing → Customer portal) so
  `/v1/billing/portal` works.

## Testing

**Unit (vitest + fakes, matching `test/` conventions):**
- `formEncode` — nested arrays/objects encode as Stripe expects.
- `verifyStripeSignature` — valid signature passes; tampered body fails; wrong secret
  fails; stale timestamp (beyond tolerance) fails; malformed header fails.
- `entitlementFromEvent` — each handled event type maps to the right fields; unknown
  types return `null`.
- Gating — keygen and bearer-generations return 402 for a free key owner and succeed for
  a paid one; the session playground stays free; the paid vs free rate-limit binding is
  selected correctly; master/dev bypass.
- Route wiring (router-test style) — checkout/portal require a session; the webhook route
  rejects an unsigned/badly-signed body with 400 and never mutates on failure.

**Local integration:**
- `wrangler dev --local` (see the `running-locally` skill) with `STRIPE_*` set in
  `.dev.vars`.
- `stripe listen --forward-to http://localhost:8787/v1/stripe/webhook` — its printed
  `whsec_…` goes into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`.
- Drive a real test-mode Checkout with card `4242 4242 4242 4242` (any future expiry /
  CVC), confirm the user flips to Unlimited, mint a key, then cancel via the Portal and
  confirm the key now 402s. (`stripe:test-cards` for more scenarios.)
- **Offline caveat (from project memory):** the generation path 500s fully offline (no
  local Vectorize / Workers AI). So local verification covers the **gating decisions**
  (402 vs allowed) and the **checkout → webhook → entitlement loop**; end-to-end image
  generation over a paid key is verified against deployed infra.

## Deployment notes (for `DEPLOY.md`)

1. Apply migration `0012`.
2. `wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`; set
   `STRIPE_PRICE_ID` in `wrangler.toml` `[vars]`.
3. Add the `RATE_LIMITER_PAID` unsafe binding (new `namespace_id`).
4. Create the production webhook endpoint in the Stripe dashboard pointing at
   `https://api.wagmi.photos/v1/stripe/webhook`, subscribed to `checkout.session.completed`
   and `customer.subscription.created|updated|deleted`; copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.
5. Create the live Product/Price and enable the live Customer Portal; put the live Price
   id in `STRIPE_PRICE_ID`.
6. **Pin the webhook endpoint's Stripe API version** to one where the subscription object
   still carries a top-level `current_period_end` (or accept that the "renews `<date>`"
   line is omitted) — see follow-up (b) below.

## Known follow-ups (post-launch, tracked from the final review)

These were reviewed and consciously deferred; none blocks launch.

(a) **Concurrent-checkout customer-link race.** `handleCheckout` creates+links a Stripe
customer per initiation. If a user starts two checkouts before either links (two tabs /
double-submit), the user row keeps the *last* customer id; completing the *other* session
makes its `customer.subscription.created` update 0 rows (silent no-op), so the user can be
briefly stranded as `plan_status = NULL` (free) despite paying. The
`checkout.session.completed` `link` event relinks the customer but does **not** set
`plan_status`, so recovery depends on a later `subscription.updated`. Low probability and
largely self-repairing. Fix options (pick one when addressed): have the `link` reducer also
persist subscription status (fetch/expand the session's subscription); or fall back to
`client_reference_id` when a subscription webhook's customer lookup misses; or return 500
(force Stripe retry) instead of 200 on a 0-row subscription update — weighing the
retry-storm risk for genuinely-unlinked customers.

(b) **`current_period_end` on newer Stripe API versions.** Stripe moved `current_period_end`
off the top-level subscription object (onto `items.data[]`) in 2025 API versions. Entitlement
is unaffected (`isPaid` never reads it), but the account "renews `<date>`" line silently
omits. Pin the webhook endpoint's API version (deploy step 6) or read
`items.data[0].current_period_end` if the renewal date matters.

(c) **Cheap test/robustness nits** (deferred): add a webhook test for the unknown-event→200
and apply-throws→500 paths; a `stripePost` fast-fail on a missing `STRIPE_SECRET_KEY`; and
minor DRY (a `paymentRequired()` helper for the two 402 sites, a shared `site` const).
Portal `return_url` does not re-fetch `/v1/me` (stale card until next load) — cosmetic since
cancel-at-period-end keeps `status = active`.
