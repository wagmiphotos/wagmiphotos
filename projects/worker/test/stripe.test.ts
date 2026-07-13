import { it, expect } from "vitest";
import { isPaid, planView } from "../src/entitlement";
import { formEncode, verifyStripeSignature, entitlementFromEvent } from "../src/stripe";

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
  expect(planView(u)).toEqual({ active: true, status: "active", current_period_end: "2027-07-08T00:00:00.000Z", cancel_at_period_end: false });
  expect(planView({ plan_status: null, plan_current_period_end: null } as any)).toEqual({ active: false, status: null, current_period_end: null, cancel_at_period_end: false });
  // A subscription set to cancel at period end is still active, but flagged.
  expect(planView({ plan_status: "active", plan_current_period_end: "2027-07-08T00:00:00.000Z", plan_cancel_at_period_end: 1 } as any))
    .toMatchObject({ active: true, cancel_at_period_end: true });
});

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
  expect(ent).toEqual({ kind: "subscription", customerId: "cus_1", subscriptionId: "sub_1", planStatus: "active", currentPeriodEnd: new Date(1893456000 * 1000).toISOString(), cancelAtPeriodEnd: false });
});

it("entitlementFromEvent captures cancel_at_period_end (active, not renewing)", () => {
  const ent = entitlementFromEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1893456000, cancel_at_period_end: true } } });
  expect(ent).toMatchObject({ kind: "subscription", planStatus: "active", cancelAtPeriodEnd: true });
});

it("entitlementFromEvent maps subscription.deleted to canceled", () => {
  const ent = entitlementFromEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } });
  expect(ent).toMatchObject({ kind: "subscription", customerId: "cus_1", planStatus: "canceled" });
});

it("entitlementFromEvent ignores unrelated events", () => {
  expect(entitlementFromEvent({ type: "invoice.created", data: { object: {} } })).toBeNull();
});

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
