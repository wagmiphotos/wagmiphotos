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
