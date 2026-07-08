# Stripe subscriptions + paid API gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a recurring annual $24 Stripe subscription and gate the programmatic (bearer-key) API behind an active subscription, while the session-authed site playground stays free.

**Architecture:** SDK-free — direct `fetch` to `api.stripe.com` (matching Resend/OpenAI/GitHub call style). Stripe-hosted Checkout + Customer Portal via redirect (no card data touches the Worker; publishable key unused). Entitlement lives on the `users` row, written by a signature-verified webhook. Enforcement keys off the pre-existing seam in `resolveApiPrincipal`: bearer key = paid API surface; session cookie = free playground.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, WebCrypto (HMAC-SHA256 for webhook verification), vitest. Spec: `docs/superpowers/specs/2026-07-08-stripe-subscriptions-paid-api-design.md`.

## Global Constraints

- **No new runtime npm dependency.** Stripe is called via `fetch`; the Stripe plugin is dev/test tooling only.
- **Money endpoints match existing conventions:** 401 = unauthenticated, 429 = rate limited, and **402 = "Unlimited plan required"** (new, for entitlement gating). JSON error bodies of shape `{ error, upgrade_url? }`.
- **Webhook signature is verified over the RAW request body** (`await request.text()`), never re-serialized JSON. Constant-time compare via the existing `constantTimeEqual`. Timestamp tolerance 300s.
- **`isPaid(user) = user.plan_status IN ('active','trialing')`** — the single entitlement rule. No separate `plan` column.
- **Secrets:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` via `wrangler secret put`. `STRIPE_PRICE_ID` is a plain `[vars]`/`.dev.vars` value.
- **Idempotent webhook writes** (upsert on the user row keyed by `stripe_customer_id`); Stripe redelivers at least once.
- **Master key + dev principal bypass all gating**, unchanged.
- **Tests run with `npm test` (`vitest run`) from `projects/worker/`.** vitest does NOT type-check (esbuild transpile), so test stubs may be partial; keep production `tsc` clean.
- Follow existing file style: small focused modules, dependency-injected `Services`, pure helpers unit-tested directly.
- Commit messages: `feat(...)`/`docs(...)` scope prefix + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## File Structure

- `projects/worker/migrations/0012_billing.sql` — **new**: adds subscription columns + index to `users`.
- `projects/worker/src/types.ts` — **modify**: `User` gains 4 fields; `UserStore` gains 3 methods; `Env` gains `STRIPE_*` + `RATE_LIMITER_PAID`; `Services` gains `stripe` + `rateLimiterPaid`; new `StripeClient` interface.
- `projects/worker/src/d1.ts` — **modify**: `getById` SELECT + new `UserStore` methods.
- `projects/worker/src/entitlement.ts` — **new**: pure `isPaid` + `planView` helpers.
- `projects/worker/src/stripe.ts` — **new**: pure `formEncode`, `verifyStripeSignature`, `entitlementFromEvent`; network `makeStripe(env)`.
- `projects/worker/src/stripe-routes.ts` — **new**: `handleCheckout`, `handlePortal`, `handleStripeWebhook`.
- `projects/worker/src/session.ts` — **modify**: `resolveApiPrincipal` returns `{ userId, via }`.
- `projects/worker/src/auth-routes.ts` — **modify**: `handleMe` includes `plan`.
- `projects/worker/src/index.ts` — **modify**: wire billing/webhook routes; gate keygen + generations; tiered rate limiter.
- `projects/worker/wrangler.toml` — **modify**: `RATE_LIMITER_PAID` binding + `STRIPE_PRICE_ID` var.
- `projects/worker/public/index.html` — **modify**: account Plan card + JS (checkout/portal/gate/return handling).
- `projects/worker/.dev.vars.example`, `DEPLOY.md`, `.env.example` — **modify**: config + runbook.
- Tests: `test/stripe.test.ts`, `test/stripe-routes.test.ts` (**new**); `test/d1.test.ts`, `test/auth-routes.test.ts`, `test/router.test.ts`, `test/fakes.ts` (**modify**).

---

### Task 1: Data model — migration `0012` + store methods

**Files:**
- Create: `projects/worker/migrations/0012_billing.sql`
- Modify: `projects/worker/src/types.ts`, `projects/worker/src/d1.ts`
- Test: `projects/worker/test/d1.test.ts`

**Interfaces:**
- Produces: `User` extended with `stripe_customer_id`, `stripe_subscription_id`, `plan_status`, `plan_current_period_end` (all `string | null`). `UserStore` gains:
  - `getByStripeCustomerId(customerId: string): Promise<User | null>`
  - `setStripeCustomer(userId: string, customerId: string): Promise<void>`
  - `setSubscriptionByCustomer(customerId: string, f: { subscriptionId: string | null; planStatus: string; currentPeriodEnd: string | null }): Promise<void>`

- [ ] **Step 1: Write the migration file**

Create `projects/worker/migrations/0012_billing.sql`:

```sql
-- Stripe subscription state, one row per user. plan_status mirrors the Stripe
-- subscription status; NULL means the user never subscribed (free tier).
-- isPaid() = plan_status IN ('active','trialing'). users is read directly (no
-- live_users view), so no view recreation is needed here.
ALTER TABLE users ADD COLUMN stripe_customer_id      TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id  TEXT;
ALTER TABLE users ADD COLUMN plan_status             TEXT;   -- 'active'|'trialing'|'past_due'|'canceled'|...; NULL => free
ALTER TABLE users ADD COLUMN plan_current_period_end TEXT;   -- ISO8601; display + grace, informational

-- Webhooks resolve the user by their Stripe customer id.
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);
```

- [ ] **Step 2: Extend the `User` type and `UserStore` interface**

In `projects/worker/src/types.ts`, replace the `User` interface and `UserStore` interface:

```ts
export interface User {
  id: string; email: string; created_at: string; last_login: string | null;
  tos_version: string | null; tos_accepted_at: string | null;
  stripe_customer_id: string | null; stripe_subscription_id: string | null;
  plan_status: string | null; plan_current_period_end: string | null;
}
export interface UserStore {
  upsertByEmail(id: string, email: string): Promise<{ id: string; email: string }>;
  getById(id: string): Promise<User | null>;
  acceptTos(userId: string, version: string, ip: string | null, userAgent: string | null): Promise<void>;
  getByStripeCustomerId(customerId: string): Promise<User | null>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  setSubscriptionByCustomer(customerId: string, f: { subscriptionId: string | null; planStatus: string; currentPeriodEnd: string | null }): Promise<void>;
}
```

- [ ] **Step 3: Write failing tests for the new store methods**

Append to `projects/worker/test/d1.test.ts` (uses the existing `fakeDb` helper at the top of that file):

```ts
const USER_ROW = {
  id: "usr_1", email: "a@b.co", created_at: "x", last_login: null,
  tos_version: null, tos_accepted_at: null,
  stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
  plan_status: "active", plan_current_period_end: "2027-07-08T00:00:00.000Z",
};

it("getById selects the subscription columns", async () => {
  const { db, calls } = fakeDb(USER_ROW);
  const { users } = makeD1Stores(db);
  const u = await users.getById("usr_1");
  expect(u?.plan_status).toBe("active");
  expect(calls[0].sql).toContain("plan_status");
  expect(calls[0].sql).toContain("stripe_customer_id");
});

it("getByStripeCustomerId looks up by customer id", async () => {
  const { db, calls } = fakeDb(USER_ROW);
  const { users } = makeD1Stores(db);
  const u = await users.getByStripeCustomerId("cus_1");
  expect(u?.id).toBe("usr_1");
  expect(calls[0].sql).toContain("WHERE stripe_customer_id = ?");
  expect(calls[0].args).toEqual(["cus_1"]);
});

it("setStripeCustomer updates the customer id for a user", async () => {
  const { db, calls } = fakeDb();
  const { users } = makeD1Stores(db);
  await users.setStripeCustomer("usr_1", "cus_9");
  expect(calls[0].sql).toContain("UPDATE users SET stripe_customer_id = ?");
  expect(calls[0].args).toEqual(["cus_9", "usr_1"]);
});

it("setSubscriptionByCustomer writes status keyed by customer id", async () => {
  const { db, calls } = fakeDb();
  const { users } = makeD1Stores(db);
  await users.setSubscriptionByCustomer("cus_1", { subscriptionId: "sub_2", planStatus: "active", currentPeriodEnd: "2027-01-01T00:00:00.000Z" });
  expect(calls[0].sql).toContain("WHERE stripe_customer_id = ?");
  expect(calls[0].args).toEqual(["sub_2", "active", "2027-01-01T00:00:00.000Z", "cus_1"]);
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `cd projects/worker && npm test -- d1`
Expected: FAIL — the new methods don't exist / SELECT lacks the columns.

- [ ] **Step 5: Implement in `d1.ts`**

In `projects/worker/src/d1.ts`, update `getById` and add the three methods inside the `users` object:

```ts
    async getById(id) {
      const row = await db.prepare(
        "SELECT id, email, created_at, last_login, tos_version, tos_accepted_at, stripe_customer_id, stripe_subscription_id, plan_status, plan_current_period_end FROM users WHERE id = ?"
      ).bind(id).first<User>();
      return row ?? null;
    },
    async getByStripeCustomerId(customerId) {
      const row = await db.prepare(
        "SELECT id, email, created_at, last_login, tos_version, tos_accepted_at, stripe_customer_id, stripe_subscription_id, plan_status, plan_current_period_end FROM users WHERE stripe_customer_id = ?"
      ).bind(customerId).first<User>();
      return row ?? null;
    },
    async setStripeCustomer(userId, customerId) {
      await db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(customerId, userId).run();
    },
    async setSubscriptionByCustomer(customerId, f) {
      // Keyed by customer id (what the webhook carries). A 0-row update (customer
      // not yet linked) is a silent no-op — the checkout 'link' event sets it.
      await db.prepare(
        "UPDATE users SET stripe_subscription_id = ?, plan_status = ?, plan_current_period_end = ? WHERE stripe_customer_id = ?"
      ).bind(f.subscriptionId, f.planStatus, f.currentPeriodEnd, customerId).run();
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd projects/worker && npm test -- d1`
Expected: PASS (all d1 tests).

- [ ] **Step 7: Commit**

```bash
git add projects/worker/migrations/0012_billing.sql projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/test/d1.test.ts
git commit -m "feat(billing): migration 0012 + user subscription store methods

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Entitlement helpers + `/v1/me` plan exposure

**Files:**
- Create: `projects/worker/src/entitlement.ts`
- Modify: `projects/worker/src/auth-routes.ts`
- Test: `projects/worker/test/stripe.test.ts` (new; entitlement section), `projects/worker/test/auth-routes.test.ts`

**Interfaces:**
- Produces: `isPaid(user: Pick<User,"plan_status"> | null | undefined): boolean`; `planView(user: User): { active: boolean; status: string | null; current_period_end: string | null }`.
- Consumes: `User` from Task 1.

- [ ] **Step 1: Write failing tests for `isPaid` / `planView`**

Create `projects/worker/test/stripe.test.ts`:

```ts
import { it, expect } from "vitest";
import { isPaid, planView } from "../src/entitlement";

it("isPaid true for active and trialing only", () => {
  expect(isPaid({ plan_status: "active" })).toBe(true);
  expect(isPaid({ plan_status: "trialing" })).toBe(true);
  expect(isPaid({ plan_status: "past_due" })).toBe(false);
  expect(isPaid({ plan_status: "canceled" })).toBe(false);
  expect(isPaid({ plan_status: null })).toBe(false);
  expect(isPaid(null)).toBe(false);
  expect(isPaid(undefined)).toBe(false);
});

it("planView projects the public plan shape", () => {
  const u: any = { plan_status: "active", plan_current_period_end: "2027-07-08T00:00:00.000Z" };
  expect(planView(u)).toEqual({ active: true, status: "active", current_period_end: "2027-07-08T00:00:00.000Z" });
  expect(planView({ plan_status: null, plan_current_period_end: null } as any)).toEqual({ active: false, status: null, current_period_end: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd projects/worker && npm test -- stripe`
Expected: FAIL — cannot find module `../src/entitlement`.

- [ ] **Step 3: Implement `entitlement.ts`**

Create `projects/worker/src/entitlement.ts`:

```ts
import type { User } from "./types";

// The single entitlement rule. Trust Stripe to flip plan_status away from
// active/trialing at the right time (past_due, canceled, or sub deleted).
export function isPaid(user: Pick<User, "plan_status"> | null | undefined): boolean {
  return !!user && (user.plan_status === "active" || user.plan_status === "trialing");
}

// Public projection of the plan for /v1/me (never leaks the customer/sub ids).
export function planView(user: User): { active: boolean; status: string | null; current_period_end: string | null } {
  return { active: isPaid(user), status: user.plan_status ?? null, current_period_end: user.plan_current_period_end ?? null };
}
```

- [ ] **Step 4: Write a failing test for `plan` in `/v1/me`**

In `projects/worker/test/auth-routes.test.ts`, add a test (the file already imports `handleMe` and has a `svc()` helper; override `users.getById`):

```ts
it("me includes the plan projection", async () => {
  const paid = svc({ users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: "active", plan_current_period_end: "2027-07-08T00:00:00.000Z" }), acceptTos: async () => {} } });
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=s` } });
  const res = await handleMe(req, {} as any, paid);
  const j: any = await res.json();
  expect(j.plan).toEqual({ active: true, status: "active", current_period_end: "2027-07-08T00:00:00.000Z" });
});
```

(If `SESSION_COOKIE` isn't already imported in this test file, add it to the existing `from "../src/session"` import.)

- [ ] **Step 5: Run to verify it fails**

Run: `cd projects/worker && npm test -- auth-routes`
Expected: FAIL — `j.plan` is undefined.

- [ ] **Step 6: Add `plan` to `handleMe`**

In `projects/worker/src/auth-routes.ts`, add the import at the top:

```ts
import { planView } from "./entitlement";
```

Then in `handleMe`, extend the returned JSON (add the `plan` key alongside `user` and `tos`):

```ts
  return Response.json({
    user: { id: user.id, email: user.email },
    plan: planView(user),
    tos: {
      current_version: TOS_VERSION,
      accepted: user.tos_version === TOS_VERSION,
      accepted_version: user.tos_version,
    },
  });
```

- [ ] **Step 7: Run tests to verify pass**

Run: `cd projects/worker && npm test -- stripe auth-routes`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add projects/worker/src/entitlement.ts projects/worker/src/auth-routes.ts projects/worker/test/stripe.test.ts projects/worker/test/auth-routes.test.ts
git commit -m "feat(billing): isPaid/planView helpers + plan in /v1/me

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pure Stripe helpers — form encode, signature verify, event reducer

**Files:**
- Create: `projects/worker/src/stripe.ts` (pure section)
- Test: `projects/worker/test/stripe.test.ts` (append)

**Interfaces:**
- Produces:
  - `formEncode(obj: Record<string, any>, prefix?: string): string`
  - `verifyStripeSignature(opts: { payload: string; header: string | null; secret: string; toleranceSec?: number; now?: number }): Promise<boolean>`
  - `entitlementFromEvent(event: any): Entitlement` where
    `Entitlement = { kind: "link"; userId: string; customerId: string } | { kind: "subscription"; customerId: string; subscriptionId: string | null; planStatus: string; currentPeriodEnd: string | null } | null`
- Consumes: `constantTimeEqual` from `./auth`.

- [ ] **Step 1: Write failing tests**

Append to `projects/worker/test/stripe.test.ts`:

```ts
import { formEncode, verifyStripeSignature, entitlementFromEvent } from "../src/stripe";

it("formEncode encodes nested arrays/objects the Stripe way", () => {
  const enc = formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { user_id: "usr_1" } });
  const parts = new Set(enc.split("&"));
  expect(parts.has("mode=subscription")).toBe(true);
  expect(parts.has(`${encodeURIComponent("line_items[0][price]")}=price_1`)).toBe(true);
  expect(parts.has(`${encodeURIComponent("line_items[0][quantity]")}=1`)).toBe(true);
  expect(parts.has(`${encodeURIComponent("metadata[user_id]")}=usr_1`)).toBe(true);
});

// Build a valid Stripe-Signature header for a known secret using WebCrypto.
async function sign(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

it("verifyStripeSignature accepts a valid signature", async () => {
  const payload = '{"hello":"world"}';
  const header = await sign(payload, "whsec_test", 1000);
  expect(await verifyStripeSignature({ payload, header, secret: "whsec_test", now: 1000 })).toBe(true);
});

it("verifyStripeSignature rejects a tampered body", async () => {
  const header = await sign('{"hello":"world"}', "whsec_test", 1000);
  expect(await verifyStripeSignature({ payload: '{"hello":"evil"}', header, secret: "whsec_test", now: 1000 })).toBe(false);
});

it("verifyStripeSignature rejects the wrong secret", async () => {
  const payload = "{}";
  const header = await sign(payload, "whsec_test", 1000);
  expect(await verifyStripeSignature({ payload, header, secret: "whsec_other", now: 1000 })).toBe(false);
});

it("verifyStripeSignature rejects a stale timestamp", async () => {
  const payload = "{}";
  const header = await sign(payload, "whsec_test", 1000);
  expect(await verifyStripeSignature({ payload, header, secret: "whsec_test", now: 1000 + 400 })).toBe(false);
});

it("verifyStripeSignature rejects a missing/malformed header", async () => {
  expect(await verifyStripeSignature({ payload: "{}", header: null, secret: "whsec_test", now: 1000 })).toBe(false);
  expect(await verifyStripeSignature({ payload: "{}", header: "garbage", secret: "whsec_test", now: 1000 })).toBe(false);
});

it("entitlementFromEvent maps checkout.session.completed to a link", () => {
  const ent = entitlementFromEvent({ type: "checkout.session.completed", data: { object: { client_reference_id: "usr_1", customer: "cus_1" } } });
  expect(ent).toEqual({ kind: "link", userId: "usr_1", customerId: "cus_1" });
});

it("entitlementFromEvent maps subscription.updated to active", () => {
  const ent = entitlementFromEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1893456000 } } });
  expect(ent).toEqual({ kind: "subscription", customerId: "cus_1", subscriptionId: "sub_1", planStatus: "active", currentPeriodEnd: new Date(1893456000 * 1000).toISOString() });
});

it("entitlementFromEvent maps subscription.deleted to canceled", () => {
  const ent = entitlementFromEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } });
  expect(ent).toMatchObject({ kind: "subscription", customerId: "cus_1", planStatus: "canceled" });
});

it("entitlementFromEvent ignores unrelated events", () => {
  expect(entitlementFromEvent({ type: "invoice.created", data: { object: {} } })).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd projects/worker && npm test -- stripe`
Expected: FAIL — cannot find `../src/stripe`.

- [ ] **Step 3: Implement the pure section of `stripe.ts`**

Create `projects/worker/src/stripe.ts`:

```ts
import { constantTimeEqual } from "./auth";

// Stripe's REST API expects application/x-www-form-urlencoded with nested keys
// like line_items[0][price]. Arrays iterate as index keys via Object.entries.
export function formEncode(obj: Record<string, any>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") parts.push(formEncode(v as Record<string, any>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join("&");
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Verify the Stripe-Signature header over the RAW body. Header form:
// "t=<unix>,v1=<hexsig>[,v1=<hexsig>...]". Reject on stale timestamp.
export async function verifyStripeSignature(opts: {
  payload: string; header: string | null; secret: string; toleranceSec?: number; now?: number;
}): Promise<boolean> {
  const { payload, header, secret } = opts;
  if (!header || !secret) return false;
  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (k === "t") t = val;
    else if (k === "v1" && val) v1.push(val);
  }
  const ts = Number(t);
  if (!t || v1.length === 0 || !Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return v1.some((sig) => sig.length === expected.length && constantTimeEqual(sig, expected));
}

export type Entitlement =
  | { kind: "link"; userId: string; customerId: string }
  | { kind: "subscription"; customerId: string; subscriptionId: string | null; planStatus: string; currentPeriodEnd: string | null }
  | null;

function customerId(obj: any): string | null {
  return typeof obj?.customer === "string" ? obj.customer : (obj?.customer?.id ?? null);
}
function isoFromUnix(sec: unknown): string | null {
  return typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

// Pure reducer: Stripe event -> the fields to persist on the user (or null to ignore).
export function entitlementFromEvent(event: any): Entitlement {
  const obj = event?.data?.object ?? {};
  const cus = customerId(obj);
  switch (event?.type) {
    case "checkout.session.completed": {
      const userId = obj.client_reference_id;
      if (!userId || !cus) return null;
      return { kind: "link", userId, customerId: cus };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      if (!cus) return null;
      return { kind: "subscription", customerId: cus, subscriptionId: obj.id ?? null, planStatus: String(obj.status ?? "incomplete"), currentPeriodEnd: isoFromUnix(obj.current_period_end) };
    }
    case "customer.subscription.deleted": {
      if (!cus) return null;
      return { kind: "subscription", customerId: cus, subscriptionId: obj.id ?? null, planStatus: "canceled", currentPeriodEnd: isoFromUnix(obj.current_period_end) };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd projects/worker && npm test -- stripe`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/stripe.ts projects/worker/test/stripe.test.ts
git commit -m "feat(billing): pure Stripe helpers (form encode, sig verify, event reducer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Stripe client (network) + `Services`/`Env` wiring

**Files:**
- Modify: `projects/worker/src/stripe.ts` (add `makeStripe`), `projects/worker/src/types.ts` (`Env`, `Services`, `StripeClient`), `projects/worker/src/index.ts` (`buildServices`)
- Test: `projects/worker/test/stripe.test.ts` (append)

**Interfaces:**
- Produces: `StripeClient` interface + `makeStripe(env: Env): StripeClient` with:
  - `createCustomer(a: { email: string; userId: string }): Promise<{ id: string }>`
  - `createCheckoutSession(a: { customerId: string; userId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<{ url: string }>`
  - `createPortalSession(a: { customerId: string; returnUrl: string }): Promise<{ url: string }>`
- Produces: `Services.stripe: StripeClient`, `Services.rateLimiterPaid: RateLimiter`, `Env.STRIPE_SECRET_KEY?/STRIPE_WEBHOOK_SECRET?/STRIPE_PRICE_ID?`, `Env.RATE_LIMITER_PAID?: RateLimitBinding`.

- [ ] **Step 1: Add types to `types.ts`**

In `projects/worker/src/types.ts`, add the `StripeClient` interface (near `RateLimiter`):

```ts
export interface StripeClient {
  createCustomer(a: { email: string; userId: string }): Promise<{ id: string }>;
  createCheckoutSession(a: { customerId: string; userId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortalSession(a: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}
```

Add to `Services`: `stripe: StripeClient;` and `rateLimiterPaid: RateLimiter;`.

Add to `Env`:

```ts
  RATE_LIMITER_PAID?: RateLimitBinding;
  STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_PRICE_ID?: string;
```

- [ ] **Step 2: Write a failing test for `makeStripe` (fetch stubbed)**

Append to `projects/worker/test/stripe.test.ts`:

```ts
import { vi, afterEach } from "vitest";
import { makeStripe } from "../src/stripe";

afterEach(() => vi.unstubAllGlobals());

it("makeStripe.createCheckoutSession posts form-encoded to Stripe with auth", async () => {
  const seen: any = {};
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    seen.url = url; seen.init = init;
    return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe/x" }), { status: 200 });
  });
  const stripe = makeStripe({ STRIPE_SECRET_KEY: "sk_test_x" } as any);
  const out = await stripe.createCheckoutSession({ customerId: "cus_1", userId: "usr_1", priceId: "price_1", successUrl: "https://s/ok", cancelUrl: "https://s/no" });
  expect(out.url).toBe("https://checkout.stripe/x");
  expect(seen.url).toBe("https://api.stripe.com/v1/checkout/sessions");
  expect(seen.init.headers.Authorization).toBe("Bearer sk_test_x");
  expect(seen.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  expect(seen.init.body).toContain("mode=subscription");
  expect(seen.init.body).toContain(encodeURIComponent("line_items[0][price]") + "=price_1");
});

it("makeStripe throws on a non-2xx Stripe response", async () => {
  vi.stubGlobal("fetch", async () => new Response("bad", { status: 400 }));
  const stripe = makeStripe({ STRIPE_SECRET_KEY: "sk_test_x" } as any);
  await expect(stripe.createCustomer({ email: "a@b.co", userId: "usr_1" })).rejects.toThrow(/stripe/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd projects/worker && npm test -- stripe`
Expected: FAIL — `makeStripe` not exported.

- [ ] **Step 4: Implement `makeStripe` in `stripe.ts`**

Add to `projects/worker/src/stripe.ts`:

```ts
import type { Env, StripeClient } from "./types";

const STRIPE_API = "https://api.stripe.com/v1";

async function stripePost(env: Env, path: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`stripe ${path} ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export function makeStripe(env: Env): StripeClient {
  return {
    async createCustomer({ email, userId }) {
      const c = await stripePost(env, "/customers", { email, metadata: { user_id: userId } });
      return { id: c.id as string };
    },
    async createCheckoutSession({ customerId, userId, priceId, successUrl, cancelUrl }) {
      const s = await stripePost(env, "/checkout/sessions", {
        mode: "subscription", customer: customerId, client_reference_id: userId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl, cancel_url: cancelUrl, allow_promotion_codes: true,
      });
      return { url: s.url as string };
    },
    async createPortalSession({ customerId, returnUrl }) {
      const s = await stripePost(env, "/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
      return { url: s.url as string };
    },
  };
}
```

- [ ] **Step 5: Wire `buildServices` in `index.ts`**

In `projects/worker/src/index.ts`, add the import:

```ts
import { makeStripe } from "./stripe";
```

In `buildServices`, after the existing `rateLimiter` definition, add `rateLimiterPaid` and include both new services in the returned object:

```ts
  const rateLimiterPaid: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER_PAID) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER_PAID.limit({ key });
      return success;
    },
  };
```

Update the `return { ... }` in `buildServices` to include `rateLimiterPaid,` and `stripe: makeStripe(env),`.

- [ ] **Step 6: Run tests to verify pass**

Run: `cd projects/worker && npm test -- stripe`
Expected: PASS. Also run the full suite to confirm nothing regressed: `npm test`.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/src/stripe.ts projects/worker/src/types.ts projects/worker/src/index.ts projects/worker/test/stripe.test.ts
git commit -m "feat(billing): Stripe REST client + services wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Route handlers — checkout, portal, webhook

**Files:**
- Create: `projects/worker/src/stripe-routes.ts`
- Modify: `projects/worker/test/fakes.ts` (extend fake `users` + add fake `stripe`/`rateLimiterPaid`)
- Test: `projects/worker/test/stripe-routes.test.ts` (new)

**Interfaces:**
- Produces: `handleCheckout(request, env, s): Promise<Response>`, `handlePortal(request, env, s): Promise<Response>`, `handleStripeWebhook(request, env, s): Promise<Response>`.
- Consumes: `resolveSession` (session.ts), `verifyStripeSignature`/`entitlementFromEvent` (stripe.ts), `Services.stripe`, `UserStore` methods from Task 1.

- [ ] **Step 1: Extend `fakes.ts`**

In `projects/worker/test/fakes.ts`, update the fake `users` store and add `stripe` + `rateLimiterPaid` to `base`:

```ts
    users: {
      upsertByEmail: async (id, email) => ({ id, email }),
      getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: null, stripe_subscription_id: null, plan_status: null, plan_current_period_end: null }),
      acceptTos: async () => {},
      getByStripeCustomerId: async () => null,
      setStripeCustomer: async () => {},
      setSubscriptionByCustomer: async () => {},
    },
    rateLimiter: { limit: async () => true },
    rateLimiterPaid: { limit: async () => true },
    stripe: {
      createCustomer: async () => ({ id: "cus_fake" }),
      createCheckoutSession: async () => ({ url: "https://checkout.stripe/fake" }),
      createPortalSession: async () => ({ url: "https://portal.stripe/fake" }),
    },
```

(Keep the existing `email` line. The `getById` override signature stays `async () => (...)`.)

- [ ] **Step 2: Write failing tests for the handlers**

Create `projects/worker/test/stripe-routes.test.ts`:

```ts
import { it, expect, vi } from "vitest";
import { handleCheckout, handlePortal, handleStripeWebhook } from "../src/stripe-routes";
import { fakeServices } from "./fakes";
import { SESSION_COOKIE } from "../src/session";

const ENV = { PUBLIC_SITE_URL: "https://wagmi.photos", STRIPE_PRICE_ID: "price_1", STRIPE_WEBHOOK_SECRET: "whsec_test" } as any;
function loggedIn(over: any = {}) {
  return fakeServices({ sessions: { create: async () => {}, resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, delete: async () => {}, purgeExpired: async () => {} }, ...over });
}
const cookie = { Cookie: `${SESSION_COOKIE}=s` };

it("checkout: 401 without a session", async () => {
  const res = await handleCheckout(new Request("https://x/v1/billing/checkout", { method: "POST" }), ENV, fakeServices());
  expect(res.status).toBe(401);
});

it("checkout: creates a customer then a session and returns the url", async () => {
  const calls: string[] = [];
  const s = loggedIn({
    users: { upsertByEmail: async () => ({ id: "usr_1", email: "a@b.co" }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: null, stripe_subscription_id: null, plan_status: null, plan_current_period_end: null }), acceptTos: async () => {}, getByStripeCustomerId: async () => null, setStripeCustomer: async (_u: string, c: string) => { calls.push("setCustomer:" + c); }, setSubscriptionByCustomer: async () => {} },
    stripe: { createCustomer: async () => { calls.push("createCustomer"); return { id: "cus_new" }; }, createCheckoutSession: async (a: any) => { calls.push("checkout:" + a.customerId); return { url: "https://checkout/x" }; }, createPortalSession: async () => ({ url: "" }) },
  });
  const res = await handleCheckout(new Request("https://x/v1/billing/checkout", { method: "POST", headers: cookie }), ENV, s);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.url).toBe("https://checkout/x");
  expect(calls).toEqual(["createCustomer", "setCustomer:cus_new", "checkout:cus_new"]);
});

it("checkout: reuses an existing customer id", async () => {
  const calls: string[] = [];
  const s = loggedIn({
    users: { upsertByEmail: async () => ({ id: "usr_1", email: "a@b.co" }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_old", stripe_subscription_id: null, plan_status: null, plan_current_period_end: null }), acceptTos: async () => {}, getByStripeCustomerId: async () => null, setStripeCustomer: async () => { calls.push("setCustomer"); }, setSubscriptionByCustomer: async () => {} },
    stripe: { createCustomer: async () => { calls.push("createCustomer"); return { id: "cus_new" }; }, createCheckoutSession: async (a: any) => ({ url: "https://checkout/" + a.customerId }), createPortalSession: async () => ({ url: "" }) },
  });
  const res = await handleCheckout(new Request("https://x/v1/billing/checkout", { method: "POST", headers: cookie }), ENV, s);
  const j: any = await res.json();
  expect(j.url).toBe("https://checkout/cus_old");
  expect(calls).toEqual([]); // no customer created, no write
});

it("portal: 404 when the user has no billing account", async () => {
  const res = await handlePortal(new Request("https://x/v1/billing/portal", { method: "POST", headers: cookie }), ENV, loggedIn());
  expect(res.status).toBe(404);
});

it("webhook: 400 on a bad signature and never writes", async () => {
  const calls: string[] = [];
  const s = fakeServices({ users: { upsertByEmail: async () => ({ id: "u", email: "e" }), getById: async () => null, acceptTos: async () => {}, getByStripeCustomerId: async () => null, setStripeCustomer: async () => { calls.push("w"); }, setSubscriptionByCustomer: async () => { calls.push("w"); } } });
  const res = await handleStripeWebhook(new Request("https://x/v1/stripe/webhook", { method: "POST", body: "{}", headers: { "Stripe-Signature": "t=1,v1=deadbeef" } }), ENV, s);
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

it("webhook: valid subscription.updated flips the user to active", async () => {
  const applied: any[] = [];
  const s = fakeServices({ users: { upsertByEmail: async () => ({ id: "u", email: "e" }), getById: async () => null, acceptTos: async () => {}, getByStripeCustomerId: async () => null, setStripeCustomer: async () => {}, setSubscriptionByCustomer: async (c: string, f: any) => { applied.push({ c, ...f }); } } });
  const payload = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1893456000 } } });
  // Sign it the way the verifier expects.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${now}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await handleStripeWebhook(new Request("https://x/v1/stripe/webhook", { method: "POST", body: payload, headers: { "Stripe-Signature": `t=${now},v1=${hex}` } }), ENV, s);
  expect(res.status).toBe(200);
  expect(applied[0]).toMatchObject({ c: "cus_1", planStatus: "active", subscriptionId: "sub_1" });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd projects/worker && npm test -- stripe-routes`
Expected: FAIL — cannot find `../src/stripe-routes`.

- [ ] **Step 4: Implement `stripe-routes.ts`**

Create `projects/worker/src/stripe-routes.ts`:

```ts
import type { Env, Services } from "./types";
import { resolveSession } from "./session";
import { verifyStripeSignature, entitlementFromEvent } from "./stripe";

export async function handleCheckout(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  const user = await s.users.getById(principal.userId);
  if (!user) return Response.json({ error: "not authenticated" }, { status: 401 });
  if (!env.STRIPE_PRICE_ID) { console.error("STRIPE_PRICE_ID unset"); return Response.json({ error: "billing unavailable" }, { status: 503 }); }

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const c = await s.stripe.createCustomer({ email: user.email, userId: user.id });
    customerId = c.id;
    await s.users.setStripeCustomer(user.id, customerId);
  }
  const site = env.PUBLIC_SITE_URL || "https://wagmi.photos";
  const { url } = await s.stripe.createCheckoutSession({
    customerId, userId: user.id, priceId: env.STRIPE_PRICE_ID,
    successUrl: `${site}/#/account?checkout=success`,
    cancelUrl: `${site}/#/pricing?checkout=cancel`,
  });
  return Response.json({ url });
}

export async function handlePortal(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  const user = await s.users.getById(principal.userId);
  if (!user?.stripe_customer_id) return Response.json({ error: "no billing account" }, { status: 404 });
  const site = env.PUBLIC_SITE_URL || "https://wagmi.photos";
  const { url } = await s.stripe.createPortalSession({ customerId: user.stripe_customer_id, returnUrl: `${site}/#/account` });
  return Response.json({ url });
}

export async function handleStripeWebhook(request: Request, env: Env, s: Services): Promise<Response> {
  // Signature is verified over the RAW body — read text, never re-serialize.
  const payload = await request.text();
  const ok = await verifyStripeSignature({ payload, header: request.headers.get("Stripe-Signature"), secret: env.STRIPE_WEBHOOK_SECRET || "" });
  if (!ok) return Response.json({ error: "invalid signature" }, { status: 400 });

  let event: any;
  try { event = JSON.parse(payload); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  const ent = entitlementFromEvent(event);
  // Upserts keyed by customer id — idempotent under Stripe's at-least-once
  // redelivery. A throw here surfaces as 500 (outer handler) so Stripe retries.
  if (ent?.kind === "link") {
    await s.users.setStripeCustomer(ent.userId, ent.customerId);
  } else if (ent?.kind === "subscription") {
    await s.users.setSubscriptionByCustomer(ent.customerId, { subscriptionId: ent.subscriptionId, planStatus: ent.planStatus, currentPeriodEnd: ent.currentPeriodEnd });
  }
  return Response.json({ received: true });
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd projects/worker && npm test -- stripe-routes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/stripe-routes.ts projects/worker/test/stripe-routes.test.ts projects/worker/test/fakes.ts
git commit -m "feat(billing): checkout, portal, and webhook route handlers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire routes + gating + tiered rate limit in `index.ts`

**Files:**
- Modify: `projects/worker/src/session.ts` (`resolveApiPrincipal` returns `via`), `projects/worker/src/index.ts`, `projects/worker/wrangler.toml`
- Test: `projects/worker/test/router.test.ts` (append)

**Interfaces:**
- Consumes: `handleCheckout`/`handlePortal`/`handleStripeWebhook` (Task 5), `isPaid` (Task 2), `resolveApiPrincipal` (now `{ userId, via }`).
- Produces: `Principal = { userId: string; via: "key" | "session" | "master" | "dev" }` exported from `session.ts`.

- [ ] **Step 1: Add `via` to `resolveApiPrincipal`**

In `projects/worker/src/session.ts`, add the exported type and update `resolveApiPrincipal`:

```ts
export type Principal = { userId: string; via: "key" | "session" | "master" | "dev" };

export async function resolveApiPrincipal(
  request: Request, env: Env, stores: { sessions: SessionStore; keys: KeyStore }
): Promise<Principal | null> {
  const token = bearer(request);
  if (token) {
    if (env.MASTER_API_KEY && constantTimeEqual(await sha256Hex(token), await sha256Hex(env.MASTER_API_KEY))) {
      return { userId: MASTER_USER_ID, via: "master" };
    }
    const owner = await stores.keys.getKeyOwner(await sha256Hex(token));
    if (owner) return { userId: owner, via: "key" };
    return null;
  }
  const session = await resolveSession(request, env, stores.sessions);
  if (session) return { userId: session.userId, via: "session" };
  if (!env.MASTER_API_KEY && isDevMode(env)) return { userId: DEV_USER_ID, via: "dev" };
  return null;
}
```

- [ ] **Step 2: Write failing router tests**

Append to `projects/worker/test/router.test.ts`. This adds a richer DB stub that answers the two queries the gating path makes (`getKeyOwner` → `FROM api_keys`; `getById` → `FROM users`):

```ts
// DB stub that returns a key owner for api_keys queries and a user row (with a
// given plan_status) for users queries — enough to drive the paid gate.
function billingDb({ owner = "usr_1", planStatus = null as string | null } = {}) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM api_keys")) return { user_id: owner };
          if (sql.includes("FROM users")) return { id: owner, email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: planStatus, plan_current_period_end: null };
          return null;
        },
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

it("generate via bearer key: 402 when the owner is not paid", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", headers: { Authorization: "Bearer sc-free" }, body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DB: billingDb({ planStatus: null }), DEV_MODE: undefined }),
  );
  expect(res.status).toBe(402);
});

it("generate via bearer key: allowed when the owner is paid", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", headers: { Authorization: "Bearer sc-paid" }, body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DB: billingDb({ planStatus: "active" }), DEV_MODE: undefined }),
  );
  expect(res.status).toBe(202); // empty pool -> pending (paid gate passed)
});

it("paid generation consults the paid rate limiter", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", headers: { Authorization: "Bearer sc-paid" }, body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DB: billingDb({ planStatus: "active" }), DEV_MODE: undefined, RATE_LIMITER_PAID: { limit: async () => ({ success: false }) } }),
  );
  expect(res.status).toBe(429);
});

it("keygen: 402 for a free user, ok for a paid user", async () => {
  // resolveSession reads sessions via env.DB; billingDb returns a user for FROM users.
  const free = await worker.fetch(
    new Request("https://x/v1/keys/generate", { method: "POST", body: "{}" }),
    fakeEnv({ DB: sessionDb({ planStatus: null }) }),
  );
  expect(free.status).toBe(402);
  const paid = await worker.fetch(
    new Request("https://x/v1/keys/generate", { method: "POST", body: "{}" }),
    fakeEnv({ DB: sessionDb({ planStatus: "active" }) }),
  );
  expect(paid.status).toBe(200);
});

// Session-authed variant: sessions.resolve reads `FROM sessions`.
function sessionDb({ planStatus = null as string | null } = {}) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM sessions")) return { user_id: "usr_1" };
          if (sql.includes("FROM users")) return { id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: null, plan_status: planStatus, plan_current_period_end: null };
          return null;
        },
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

it("webhook route: 400 on an unsigned body", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/stripe/webhook", { method: "POST", body: "{}" }),
    fakeEnv({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
  );
  expect(res.status).toBe(400);
});
```

Note: for the keygen test, the browser sends the session cookie; here the request has no cookie, so `resolveSession` returns null → 401, not 402. Fix the keygen tests to include a cookie: add `headers: { Cookie: "wagmi_session=s" }` to both keygen requests so `sessionDb`'s `FROM sessions` branch resolves.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `cd projects/worker && npm test -- router`
Expected: FAIL — routes not wired / gating absent.

- [ ] **Step 4: Wire the routes and gating in `index.ts`**

In `projects/worker/src/index.ts`, add imports:

```ts
import { handleCheckout, handlePortal, handleStripeWebhook } from "./stripe-routes";
import { isPaid } from "./entitlement";
```

Add the three routes (place near the other `/v1/...` routes, before the library routes):

```ts
      if (url.pathname === "/v1/billing/checkout" && request.method === "POST")
        return await handleCheckout(request, env, services);
      if (url.pathname === "/v1/billing/portal" && request.method === "POST")
        return await handlePortal(request, env, services);
      if (url.pathname === "/v1/stripe/webhook" && request.method === "POST")
        return await handleStripeWebhook(request, env, services);
```

Replace the keygen route body with the paid gate:

```ts
      if (url.pathname === "/v1/keys/generate" && request.method === "POST") {
        const principal = await resolveSession(request, env, services.sessions);
        if (!principal) return Response.json({ error: "login required" }, { status: 401 });
        const user = await services.users.getById(principal.userId);
        if (!isPaid(user)) return Response.json({ error: "Unlimited plan required", upgrade_url: `${verifyBase}/#/account` }, { status: 402 });
        return await handleKeygen(request, services, genKey, principal.userId);
      }
```

Replace the generations principal/rate-limit block (keep the body-parse + `handleGenerate` call unchanged):

```ts
      if (url.pathname === "/v1/images/generations" && request.method === "POST") {
        const principal = await resolveApiPrincipal(request, env, services);
        if (!principal) return Response.json({ error: "Invalid API Key" }, { status: 401 });
        // The programmatic (bearer-key) API is the paid surface; the session
        // playground stays free. Master/dev bypass and use the higher limiter.
        let paid = principal.via === "master" || principal.via === "dev";
        if (principal.via === "key") {
          const owner = await services.users.getById(principal.userId);
          if (!isPaid(owner)) return Response.json({ error: "Unlimited plan required", upgrade_url: `${verifyBase}/#/account` }, { status: 402 });
          paid = true;
        }
        const limiter = paid ? services.rateLimiterPaid : services.rateLimiter;
        if (!(await limiter.limit(`gen:${principal.userId}`))) {
          return Response.json({ error: "Too many requests" }, { status: 429 });
        }
        // ... existing body parse + cfg + handleGenerate(body, services, cfg) unchanged ...
      }
```

- [ ] **Step 5: Add the wrangler binding + price var**

In `projects/worker/wrangler.toml`, after the existing `RATE_LIMITER` unsafe binding, add:

```toml
# Higher generation limit for paid (bearer-key) traffic. namespace_id must be
# unique across the account's ratelimit namespaces.
[[unsafe.bindings]]
name = "RATE_LIMITER_PAID"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 120, period = 60 }
```

And in `[vars]` add:

```toml
STRIPE_PRICE_ID = "price_REPLACE_ME"   # recurring annual $24 Price id (sandbox now, live at launch)
```

Also update the secrets comment in `[vars]` to list the Stripe secrets:

```toml
# Secrets (set with `wrangler secret put`): MASTER_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
```

- [ ] **Step 6: Run the whole suite**

Run: `cd projects/worker && npm test`
Expected: PASS (all files). If a pre-existing router test asserted the old keygen "any logged-in user" behavior, update it to expect 402 for a free/unpaid session.

- [ ] **Step 7: Typecheck**

Run: `cd projects/worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add projects/worker/src/session.ts projects/worker/src/index.ts projects/worker/wrangler.toml projects/worker/test/router.test.ts
git commit -m "feat(billing): gate the bearer API behind an active plan + tiered rate limit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — account Plan card, checkout/portal, key gating

**Files:**
- Modify: `projects/worker/public/index.html`

**Interfaces:**
- Consumes: `GET /v1/me` → now returns `plan: { active, status, current_period_end }`; `POST /v1/billing/checkout` → `{ url }`; `POST /v1/billing/portal` → `{ url }`.
- Uses existing helpers: `currentUser` (module-scoped), `fetchMe`, `loadKeys`, `showToast`, `openCreateKey`, the `#/account` route `onShow`.

- [ ] **Step 1: Store the plan on `currentUser`**

In `fetchMe` (around line 3969), keep the whole `me` object so the plan is available. Change:

```js
        if (r.ok) { const me = await r.json(); currentUser = me.user; currentPlan = me.plan || null; showTosGate(me.tos); }
        else { currentUser = null; currentPlan = null; }
```

And add a module-scoped declaration next to `let currentUser = null;` (line 3914):

```js
    let currentPlan = null;
```

Also set `currentPlan = null;` wherever `currentUser = null;` is set on logout (around line 4035).

- [ ] **Step 2: Add the Plan card markup**

In the account view, insert a new card **before** the Credentials card (i.e., immediately before the `<!-- Credentials Card -->` comment near line 3184). Paste:

```html
      <!-- Plan Card -->
      <div class="glass-card">
        <h2 class="card-title">Plan</h2>
        <div id="plan-body" style="font-size: 0.9375rem; color: var(--muted);">Loading…</div>
      </div>
```

- [ ] **Step 3: Add the plan render + billing actions JS**

Add these functions near `loadKeys` (e.g. after `formatKeyDate`, ~line 4343):

```js
    function renderPlan() {
      const el = document.getElementById('plan-body');
      if (!el) return;
      const active = !!(currentPlan && currentPlan.active);
      if (active) {
        const until = currentPlan.current_period_end ? new Date(currentPlan.current_period_end) : null;
        const when = until && !isNaN(until.getTime()) ? until.toLocaleDateString() : null;
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div><b style="color:var(--ink);">Unlimited</b>${when ? ` · renews ${escapeHtml(when)}` : ''}</div>
          <button class="btn" style="height:38px;width:auto;padding:0 16px;" onclick="openPortal(this)">Manage billing</button>
        </div>`;
      } else {
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div><b style="color:var(--ink);">Free</b> · playground &amp; closest-match search</div>
          <button class="btn btn-primary" style="height:40px;width:auto;padding:0 18px;" onclick="startCheckout(this)">Upgrade to Unlimited — $24/yr</button>
        </div>`;
      }
      // Gate the "Create API key" button for free users.
      const keyBtn = document.getElementById('create-key-btn');
      if (keyBtn) {
        keyBtn.disabled = !active;
        keyBtn.title = active ? '' : 'Upgrade to Unlimited to create API keys';
      }
      const keyHint = document.getElementById('key-gate-hint');
      if (keyHint) keyHint.hidden = active;
    }

    async function startCheckout(btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
      try {
        const r = await fetch('/v1/billing/checkout', { method: 'POST', credentials: 'same-origin' });
        if (r.status === 401) { location.hash = '#/login'; return; }
        if (!r.ok) throw new Error('checkout failed');
        const { url } = await r.json();
        location.assign(url);
      } catch { if (btn) { btn.disabled = false; btn.textContent = 'Upgrade to Unlimited — $24/yr'; } showToast('Could not start checkout', 'error'); }
    }

    async function openPortal(btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
      try {
        const r = await fetch('/v1/billing/portal', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) throw new Error('portal failed');
        const { url } = await r.json();
        location.assign(url);
      } catch { if (btn) { btn.disabled = false; btn.textContent = 'Manage billing'; } showToast('Could not open billing portal', 'error'); }
    }
```

- [ ] **Step 4: Add the id + gate hint to the "Create API key" button**

In the Credentials card (line ~3200) give the button an id and add a hint span right after it:

```html
          <button id="create-key-btn" class="btn btn-primary" style="height: 40px; width: auto; padding: 0 18px; font-size: 0.875rem;" onclick="openCreateKey()">Create API key</button>
          <span id="key-gate-hint" hidden style="display:block;margin-top:10px;font-size:0.75rem;color:var(--muted);">API keys are an Unlimited feature — <a href="#" onclick="document.getElementById('plan-body')?.scrollIntoView({behavior:'smooth'});return false;" style="color:var(--red);">upgrade to create one</a>.</span>
```

- [ ] **Step 5: Render the plan on account show + handle the checkout return**

In the `#/account` route `onShow` (line ~3869), call `renderPlan()` and handle `?checkout=success` (re-fetch `/me` since the webhook — not the redirect — grants access):

```js
      '#/account':    { view: 'view-account', onShow: async () => {
        const emailEl = document.getElementById('account-email');
        if (emailEl) emailEl.textContent = currentUser ? currentUser.email : '—';
        updateStats();
        loadKeys();
        const q = new URLSearchParams(location.hash.split('?')[1] || '');
        if (q.get('checkout') === 'success') {
          await fetchMe();              // webhook may already have granted access
          showToast("You're on Unlimited 🎉", 'success');
          history.replaceState(null, '', '#/account');
        }
        renderPlan();
      } },
```

- [ ] **Step 6: Belt-and-suspenders — 402 from keygen re-syncs the plan**

In `submitCreateKey` (line ~4317), after the existing `if (r.status === 401)` line, add a 402 branch:

```js
        if (r.status === 402) { closeCreateKey(); await fetchMe(); renderPlan(); showToast('Upgrade to Unlimited to create API keys', 'error'); return; }
```

- [ ] **Step 7: Verify in the browser (manual, no test framework for the SPA)**

Run the app per the `running-locally` skill (`cd projects/worker && npx wrangler dev --local`), with Stripe vars in `.dev.vars` (Task 8 sets these). Log in via the dev magic link, open `#/account`, confirm the Free Plan card renders and "Create API key" is disabled with the hint. (The full paid round-trip is exercised in Task 8's integration run.)

- [ ] **Step 8: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(billing): account Plan card, checkout/portal, and key gating UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Config, docs, and local integration verification

**Files:**
- Modify: `projects/worker/.dev.vars.example`, `.env.example`, `DEPLOY.md`

- [ ] **Step 1: Update `.dev.vars.example`**

Set `projects/worker/.dev.vars.example` to:

```
# copy to .dev.vars for local dev
DEV_MODE=true
PUBLIC_SITE_URL=http://localhost:8787

# Stripe (test mode). STRIPE_WEBHOOK_SECRET is printed by `stripe listen`.
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
```

- [ ] **Step 2: Add a Stripe section to `DEPLOY.md`**

Add a "Stripe billing" subsection to `DEPLOY.md` capturing the spec's Deployment notes: apply migration `0012`; `wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`; set `STRIPE_PRICE_ID` in `[vars]`; add the `RATE_LIMITER_PAID` binding (unique `namespace_id`); create the dashboard webhook endpoint at `https://api.wagmi.photos/v1/stripe/webhook` subscribed to `checkout.session.completed` + `customer.subscription.created|updated|deleted` and copy its signing secret; create the live Product/Price (`unit_amount=2400`, `currency=usd`, `recurring[interval]=year`); enable the live Customer Portal.

- [ ] **Step 3: Note the Stripe keys in `.env.example`**

If `.env.example` documents worker/runtime env, append the same three `STRIPE_*` entries with `sk_test_...` placeholders and a one-line comment that the publishable key is unused (hosted Checkout only).

- [ ] **Step 4: Create the sandbox Product/Price**

Via the Stripe MCP (or dashboard): create Product "wagmi.photos Unlimited" + a recurring Price `unit_amount=2400 currency=usd recurring[interval]=year`. Put the returned `price_...` in `.dev.vars` as `STRIPE_PRICE_ID`. Enable the Customer Portal in the sandbox (Settings → Billing → Customer portal).

- [ ] **Step 5: Local integration run**

```bash
cd projects/worker
# terminal A
npx wrangler dev --local
# terminal B (Stripe CLI): copy the printed whsec_... into .dev.vars, restart wrangler
stripe listen --forward-to http://localhost:8787/v1/stripe/webhook
```

Then, with the dev login: open `#/account` → Upgrade → complete Checkout with card `4242 4242 4242 4242` (any future expiry / any CVC / any ZIP). Confirm:
1. The `customer.subscription.created` (or `.updated`) webhook is delivered and returns 200 in the `stripe listen` log.
2. Returning to `#/account?checkout=success` shows "Unlimited" and enables "Create API key".
3. Mint a key; `POST /v1/keys/generate` returns 200.
4. In the Portal ("Manage billing") cancel immediately; after the `customer.subscription.deleted`/`updated(canceled)` webhook, `#/account` shows Free again and a bearer call to `/v1/images/generations` with that key returns **402**.

**Offline caveat:** image generation itself 500s locally (no Vectorize/Workers AI). Verify the gating status codes (402 vs 202/200) and the checkout→webhook→entitlement loop; end-to-end generation over a paid key is confirmed against deployed infra.

- [ ] **Step 6: Full test + typecheck gate**

Run: `cd projects/worker && npm test && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/.dev.vars.example .env.example DEPLOY.md
git commit -m "docs(billing): Stripe env + deploy runbook and local test recipe

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Billing model (annual subscription, hosted Checkout + Portal) → Tasks 4, 5, 7, 8. ✅
- Free/paid seam (bearer=paid, session=free) → Task 6 (`via` + gating). ✅
- Data model migration 0012 + derived `isPaid` → Tasks 1, 2. ✅
- `stripe.ts` pure helpers (formEncode, verifyStripeSignature, entitlementFromEvent) → Task 3. ✅
- Injected Stripe client + Services wiring → Task 4. ✅
- Routes checkout/portal/webhook (raw-body signature verify, idempotent upserts) → Tasks 5, 6. ✅
- Gating points: keygen 402, bearer-generations 402, session playground free, tiered rate limit → Task 6. ✅
- `/v1/me` plan exposure → Task 2. ✅
- Frontend Plan card, upgrade/portal, key gating, return handling → Task 7. ✅
- Config/secrets, publishable-key-unused note, deploy runbook → Tasks 6, 8. ✅
- Testing (unit matrix + local integration) → Tasks 1–6 (unit) + Task 8 (integration). ✅

**Placeholder scan:** `price_REPLACE_ME` / `sk_test_...` are intentional config placeholders, not plan gaps. No "TBD"/"handle edge cases"/"similar to". ✅

**Type consistency:** `Principal.via` values (`key|session|master|dev`) match their use in Task 6 gating. `Entitlement` union (Task 3) matches `handleStripeWebhook` branches (Task 5). `UserStore` method names (`getByStripeCustomerId`, `setStripeCustomer`, `setSubscriptionByCustomer`) are consistent across Tasks 1, 5, 6, and `fakes.ts`. `planView`/`isPaid` signatures consistent across Tasks 2, 6, 7. `StripeClient` methods consistent across Tasks 4, 5, `fakes.ts`. ✅
