import type { AssetRow, Services } from "./types";
import { decryptSecret } from "./crypto";
import { deniedTerm } from "./denylist";
import { moderationFlagged } from "./moderation";
import { providerFor as realProviderFor, ProviderAuthError, type ImageProvider, type GeneratedImage } from "./providers";
import contract from "../../../contract.json";

export interface ByokBucket { put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; }
export interface ByokCfg {
  kek?: string;
  moderationKey?: string;
  bucket?: ByokBucket;
  publicUrlBase?: string;
  now: () => number;
  fetchFn?: typeof fetch;
  providerFor?: (name: string) => ImageProvider;
  uuid?: () => string;
}
export type ByokOutcome =
  | { kind: "generated"; asset: AssetRow; used: number; cap: number; estSpendUsd: number }
  | { kind: "content_policy"; category: string }
  | { kind: "cap_reached" }
  | { kind: "provider_error" }
  | { kind: "skipped" };

export function monthKey(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 7);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp" };

// The BYOK in-request generation path. Ordering is load-bearing:
// guardrails (fail-closed) -> atomic quota reserve -> provider -> durable
// persist (R2 + D1) -> best-effort index -> accounting. Failures from the
// provider call through insertGenerated refund the reservation (and an auth
// failure also disables the key); once the asset is durable (insertGenerated
// has succeeded), everything after is best-effort only — it never refunds
// and never fails the request.
export async function tryByokGenerate(
  i: { userId: string; prompt: string; vec: number[]; collectionId?: string | null }, s: Services, cfg: ByokCfg
): Promise<ByokOutcome> {
  if (!cfg.kek || !cfg.bucket || !cfg.publicUrlBase) return { kind: "skipped" };
  const row = await s.byok.get(i.userId);
  if (!row || !row.enabled) return { kind: "skipped" };
  const pinned = (contract as any).byok_providers[row.provider];
  if (!pinned) return { kind: "skipped" };

  const term = deniedTerm(i.prompt);
  if (term) return { kind: "content_policy", category: `denylist:${term}` };

  let apiKey: string;
  try { apiKey = await decryptSecret(row.key_ciphertext, cfg.kek); }
  catch (e) {
    // KEK rotated or ciphertext corrupted: without this disable the account
    // card looks healthy while every request silently falls back.
    console.error("byok decrypt failed", e);
    try { await s.byok.disable(i.userId, "decrypt_failed"); } catch (de) { console.error("byok disable failed", de); }
    return { kind: "provider_error" };
  }

  // openai users are moderated with their own key (the endpoint is free);
  // gmicloud users need the operator OPENAI_API_KEY. No key => never generate.
  const modKey = row.provider === "openai" ? apiKey : cfg.moderationKey;
  if (!modKey) return { kind: "skipped" };
  let category: string | null;
  try { category = await moderationFlagged(i.prompt, modKey, cfg.fetchFn ?? fetch); }
  catch (e) { console.error("byok moderation unavailable", e); return { kind: "provider_error" }; }
  if (category) return { kind: "content_policy", category };

  const month = monthKey(cfg.now());
  if (!(await s.byok.reserve(i.userId, month, row.monthly_cap))) return { kind: "cap_reached" };

  const id = (cfg.uuid ?? (() => crypto.randomUUID()))();
  let img!: GeneratedImage;
  let sourceUrl!: string;
  try {
    const provider = (cfg.providerFor ?? ((n: string) => realProviderFor(n, cfg.fetchFn ?? fetch)))(row.provider);
    img = await provider.generate(i.prompt, apiKey);
    const key = `byok/${id}/original.${EXT[img.mime] ?? "png"}`;
    await cfg.bucket.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    sourceUrl = `${cfg.publicUrlBase.replace(/\/+$/, "")}/${key}`;
    await s.assets.insertGenerated({
      id, prompt: i.prompt, sourceUrl, mime: img.mime,
      width: 1024, height: 1024, // requested size; providers may letterbox but 1024x1024 is what we ask for
      modelUsed: pinned.model, provider: row.provider, priceUsd: pinned.price_per_image_usd,
      createdBy: i.userId, // audit trail (AUP/takedown); never selected on public reads
      collectionId: i.collectionId ?? null,
    });
  } catch (e) {
    console.error("byok generation failed", e);
    try { await s.byok.refund(i.userId, month); } catch (re) { console.error("byok refund failed", re); }
    if (e instanceof ProviderAuthError) {
      try { await s.byok.disable(i.userId, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
    }
    return { kind: "provider_error" };
  }

  // Durable + paid past this point: best-effort bookkeeping only — never
  // refund, never fail the request.
  try { await s.vectorize.upsert(id, i.vec); } catch (e) { console.error("byok vector upsert failed", e); }
  if (i.collectionId) {
    // Second, namespace-scoped write so scoped search can find it. Best-effort:
    // a failure leaves the image globally findable but scoped-invisible until re-generated demand re-lands it.
    try { await s.vectorize.upsertNamespace(id, i.vec, i.collectionId); } catch (e) { console.error("byok namespace upsert failed", e); }
  }
  try { await s.byok.addSpend(i.userId, month, pinned.price_per_image_usd); } catch (e) { console.error("byok addSpend failed", e); }
  let used = 1;
  let estSpendUsd = pinned.price_per_image_usd;
  try {
    const usage = await s.byok.getUsage(i.userId, month);
    used = usage.count;
    estSpendUsd = usage.est_spend_usd;
  } catch (e) { console.error("byok usage read failed", e); }
  const asset: AssetRow = {
    id, prompt: i.prompt, source: "byok", source_id: null, model_used: pinned.model,
    width: 1024, height: 1024, // requested size; providers may letterbox but 1024x1024 is what we ask for
    mime: img.mime, source_url: sourceUrl, locally_cached: 0,
  };
  return { kind: "generated", asset, used, cap: row.monthly_cap, estSpendUsd };
}
