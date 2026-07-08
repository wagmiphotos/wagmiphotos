import { constantTimeEqual } from "./auth";
import type { Env, StripeClient } from "./types";

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
