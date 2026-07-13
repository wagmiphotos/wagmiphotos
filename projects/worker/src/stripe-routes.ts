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
    await s.users.setSubscriptionByCustomer(ent.customerId, { subscriptionId: ent.subscriptionId, planStatus: ent.planStatus, currentPeriodEnd: ent.currentPeriodEnd, cancelAtPeriodEnd: ent.cancelAtPeriodEnd });
  }
  return Response.json({ received: true });
}
