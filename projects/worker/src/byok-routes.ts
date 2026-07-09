import type { Env, Services } from "./types";
import { resolveSession } from "./session";
import { encryptSecret } from "./crypto";
import { providerFor } from "./providers";
import { monthKey } from "./byok";
import contract from "../../../contract.json";

// Key management is session-cookie only: you manage your provider key from
// the account page, never with a bearer key (a leaked sc- key must not be
// able to read, replace, or redirect provider spend).
export type ValidateKey = (provider: string, apiKey: string) => Promise<boolean>;
const defaultValidate: ValidateKey = (provider, apiKey) => providerFor(provider).validateKey(apiKey);
const PROVIDERS = new Set(["openai", "gmicloud"]);

export async function byokView(s: Services, userId: string, nowSec: number): Promise<{
  provider: string; key_last4: string; enabled: boolean; monthly_cap: number;
  used_this_month: number; est_spend_usd: number; price_per_image: number | null; last_error: string | null;
} | null> {
  const row = await s.byok.get(userId);
  if (!row) return null;
  const usage = await s.byok.getUsage(userId, monthKey(nowSec));
  const pinned = (contract as any).byok_providers[row.provider];
  return {
    provider: row.provider, key_last4: row.key_last4, enabled: !!row.enabled,
    monthly_cap: row.monthly_cap, used_this_month: usage.count,
    est_spend_usd: Math.round(usage.est_spend_usd * 100) / 100,
    price_per_image: pinned?.price_per_image_usd ?? null,
    last_error: row.last_error,
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function handlePutByok(request: Request, env: Env, s: Services, validate: ValidateKey = defaultValidate): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  if (!env.BYOK_KEK) return Response.json({ error: "BYOK is not configured on this deployment" }, { status: 503 });
  const ok = await s.rateLimiter.limit(`byok:ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`);
  if (!ok) return Response.json({ error: "Too many requests" }, { status: 429 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const provider = body?.provider;
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
    return Response.json({ error: "provider must be 'openai' or 'gmicloud'" }, { status: 422 });
  }
  // Clipboard pastes carry trailing whitespace/newlines; some provider
  // endpoints tolerate it in the Bearer header and others fail opaquely
  // (observed: OpenAI /models accepts, images/generations 520s). Trim first.
  const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : body?.api_key;
  if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 300) {
    return Response.json({ error: "api_key must be a string of 8-300 characters" }, { status: 422 });
  }
  const cap = body?.monthly_cap ?? 50;
  if (!Number.isInteger(cap) || cap < 1 || cap > 10000) {
    return Response.json({ error: "monthly_cap must be an integer between 1 and 10000" }, { status: 422 });
  }
  const enabled = body?.enabled ?? true;
  if (typeof enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });

  let valid = false;
  try { valid = await validate(provider, apiKey); } catch (e) { console.error("byok key validation errored", e); }
  if (!valid) return Response.json({ error: "key_rejected", detail: "the provider did not accept this key" }, { status: 400 });

  await s.byok.put({
    userId: principal.userId, provider,
    keyCiphertext: await encryptSecret(apiKey, env.BYOK_KEK),
    keyLast4: apiKey.slice(-4), monthlyCap: cap, enabled,
  });
  return Response.json({ byok: await byokView(s, principal.userId, nowSec()) });
}

export async function handlePatchByok(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const f: { enabled?: boolean; monthlyCap?: number } = {};
  if (body?.enabled != null) {
    if (typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });
    f.enabled = body.enabled;
  }
  if (body?.monthly_cap != null) {
    if (!Number.isInteger(body.monthly_cap) || body.monthly_cap < 1 || body.monthly_cap > 10000) {
      return Response.json({ error: "monthly_cap must be an integer between 1 and 10000" }, { status: 422 });
    }
    f.monthlyCap = body.monthly_cap;
  }
  if (!(await s.byok.get(principal.userId))) return Response.json({ error: "no BYOK key on this account" }, { status: 404 });
  await s.byok.patch(principal.userId, f);
  return Response.json({ byok: await byokView(s, principal.userId, nowSec()) });
}

export async function handleDeleteByok(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  await s.byok.delete(principal.userId);
  return Response.json({ status: "ok" });
}
