import type { Services, AssetRow, Match, CollectionRow } from "./types";
import { similarityFloor } from "./floor";
import { normalizePrompt } from "./normalize";
import { sha256Hex } from "./auth";
import { assetUrls } from "./asset-urls";
import { tryByokGenerate, type ByokCfg, type ByokOutcome } from "./byok";
import { combinedPrompt } from "./collections";

export interface GenBody { prompt: string; n?: number; size?: string; cache_tolerance?: number; generate_on_miss?: boolean; collection?: string; }
export interface GenCfg { floorSimMax: number; floorSimMin: number; imagePrice: number; now: () => number; assetBaseUrl?: string; }

/** Default cache_tolerance (contract.json: default_cache_tolerance). */
export const DEFAULT_CACHE_TOLERANCE = 0.15;
export const MAX_PROMPT_LEN = 2000;

// Orphan vectors are possible when the backfill's D1 insert fails after the
// Vectorize upsert; fetching a few candidates lets one orphan not hide the cache.
const QUERY_TOP_K = 3;

// BYOK fires exactly where the response would be approximate/pending and the
// request did not opt out of generation. Returns null when BYOK didn't take
// over (skipped / fallback) so the caller continues with today's behavior;
// fallbackStatus carries cap_reached/provider_error into the fallback body.
async function runByok(
  byok: { userId: string; cfg: ByokCfg } | null | undefined,
  generateOnMiss: boolean, prompt: string, vec: number[], s: Services,
  collectionId: string | null
): Promise<{ outcome: ByokOutcome | null; fallbackStatus: string | null }> {
  if (!byok || !generateOnMiss) return { outcome: null, fallbackStatus: null };
  let outcome: ByokOutcome;
  try {
    outcome = await tryByokGenerate({ userId: byok.userId, prompt, vec, collectionId }, s, byok.cfg);
  } catch (e) {
    // A throw here (e.g. a transient D1 error from s.byok.get/reserve) must
    // never 500 the request: degrade to the normal approximate/pending path.
    console.error("byok path failed", e);
    return { outcome: null, fallbackStatus: "provider_error" };
  }
  if (outcome.kind === "generated" || outcome.kind === "content_policy") return { outcome, fallbackStatus: null };
  if (outcome.kind === "cap_reached" || outcome.kind === "provider_error") return { outcome: null, fallbackStatus: outcome.kind };
  return { outcome: null, fallbackStatus: null }; // skipped
}

function generatedResponse(outcome: Extract<ByokOutcome, { kind: "generated" }>, cfg: GenCfg, collectionId: string | null): Response {
  const u = assetUrls(outcome.asset, cfg.assetBaseUrl);
  return Response.json({
    created: cfg.now(),
    data: [{ url: u.url }],
    shared_cache: {
      result: "generated",
      similarity: 1,
      cost_saved_usd: 0,
      model_used: outcome.asset.model_used,
      source: outcome.asset.source,
      sizes: { thumb: u.thumb_url, medium: u.medium_url, large: u.url },
      original_url: u.original_url,
      byok: { used: outcome.used, cap: outcome.cap, est_spend_usd: outcome.estSpendUsd },
      ...(collectionId ? { collection: collectionId } : {}),
    },
  });
}

// Best-effort owner-facing stat: only hit/approximate returns count ("matched
// and returned"), never the initial generated response and never library reads.
async function bumpServed(s: Services, assetId: string): Promise<void> {
  try { await s.assets.bumpServeCount(assetId); } catch (e) { console.error("bumpServeCount failed", e); }
}

export async function handleGenerate(
  body: GenBody, s: Services, cfg: GenCfg,
  byok?: { userId: string; cfg: ByokCfg } | null
): Promise<Response> {
  if (body.n != null && body.n !== 1) {
    return Response.json({ error: "only n=1 is supported" }, { status: 422 });
  }
  if (body.generate_on_miss != null && typeof body.generate_on_miss !== "boolean") {
    return Response.json({ error: "generate_on_miss must be a boolean" }, { status: 422 });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return Response.json({ error: "prompt must be a non-empty string" }, { status: 422 });
  }
  if (body.prompt.length > MAX_PROMPT_LEN) {
    return Response.json({ error: `prompt must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
  }
  if (body.cache_tolerance != null &&
      (typeof body.cache_tolerance !== "number" || !Number.isFinite(body.cache_tolerance) ||
       body.cache_tolerance < 0 || body.cache_tolerance > 1)) {
    return Response.json({ error: "cache_tolerance must be a number between 0 and 1" }, { status: 422 });
  }
  if (body.collection != null && (typeof body.collection !== "string" || body.collection === "")) {
    return Response.json({ error: "collection must be a non-empty string" }, { status: 422 });
  }
  let coll: CollectionRow | null = null;
  if (body.collection) {
    coll = await s.collections.get(body.collection);
    if (!coll) return Response.json({ error: "unknown collection" }, { status: 404 });
    if (combinedPrompt(body.prompt, coll.theme_prompt).length > MAX_PROMPT_LEN) {
      return Response.json({ error: `prompt plus collection theme must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
    }
  }
  const prompt = coll ? combinedPrompt(body.prompt, coll.theme_prompt) : body.prompt;
  const tol = body.cache_tolerance ?? DEFAULT_CACHE_TOLERANCE;
  const generateOnMiss = body.generate_on_miss ?? true;
  const floor = similarityFloor(tol, cfg.floorSimMax, cfg.floorSimMin);
  const normalized = normalizePrompt(prompt);

  // Scoped generation is owner-only: a non-owner's own BYOK key must never
  // spend into (or theme-pollute) someone else's collection.
  const gen = coll && byok && byok.userId !== coll.owner_user_id ? null : byok;

  const vec = await s.embedder.textEmbed(prompt);
  const matches = coll
    ? await s.vectorize.queryNamespace(vec, coll.id, QUERY_TOP_K)
    : await s.vectorize.query(vec, QUERY_TOP_K);
  // Serve the best match whose D1 asset row still exists (skip orphan vectors).
  let best: Match | null = null;
  let asset: AssetRow | null = null;
  for (const m of matches) {
    const row = await s.assets.getAsset(m.id);
    if (row) { best = m; asset = row; break; }
  }

  // empty pool: nothing to serve
  if (!best || !asset) {
    const b = await runByok(gen, generateOnMiss, prompt, vec, s, coll?.id ?? null);
    if (b.outcome?.kind === "content_policy") {
      return Response.json({ error: "content_policy", category: b.outcome.category }, { status: 400 });
    }
    if (b.outcome?.kind === "generated") {
      if (!coll) {
        try {
          await s.queries.recordQuery({ normalized, original: prompt, assetId: b.outcome.asset.id, similarity: 1, built: true, generate: false });
        } catch (e) { console.error("recordQuery failed", e); }
      }
      return generatedResponse(b.outcome, cfg, coll?.id ?? null);
    }
    let generationQueued = false;
    if (!coll) {
      try {
        generationQueued = await s.queries.recordQuery({
          normalized, original: prompt, assetId: null, similarity: 0, built: false, generate: generateOnMiss,
        });
      } catch (e) { console.error("recordQuery failed", e); } // demand write failed: nothing queued
    }
    return Response.json(
      {
        created: cfg.now(), data: [],
        shared_cache: {
          result: "pending", similarity: 0, cost_saved_usd: 0,
          ...(coll ? { collection: coll.id, generation_queued: false } : { generation_queued: generationQueued }),
          ...(b.fallbackStatus ? { byok: { status: b.fallbackStatus } } : {}),
        },
      },
      { status: 202 }
    );
  }

  const isHit = best.score >= floor;
  const result = isHit ? "hit" : "approximate";
  let byokFallbackStatus: string | null = null;
  if (!isHit) {
    const b = await runByok(gen, generateOnMiss, prompt, vec, s, coll?.id ?? null);
    if (b.outcome?.kind === "content_policy") {
      return Response.json({ error: "content_policy", category: b.outcome.category }, { status: 400 });
    }
    if (b.outcome?.kind === "generated") {
      if (!coll) {
        try {
          await s.queries.recordQuery({ normalized, original: prompt, assetId: b.outcome.asset.id, similarity: 1, built: true, generate: false });
        } catch (e) { console.error("recordQuery failed", e); }
      }
      return generatedResponse(b.outcome, cfg, coll?.id ?? null);
    }
    byokFallbackStatus = b.fallbackStatus;
  }
  let generationQueued = false;
  if (!coll) {
    try {
      generationQueued = await s.queries.recordQuery({
        normalized, original: prompt, assetId: asset.id, similarity: best.score, built: isHit, generate: generateOnMiss,
      });
    } catch (e) { console.error("recordQuery failed", e); } // demand write failed: nothing queued
  }
  await bumpServed(s, asset.id);
  const u = assetUrls(asset, cfg.assetBaseUrl);
  return Response.json({
    created: cfg.now(),
    data: [{ url: u.url }],
    shared_cache: {
      result,
      similarity: best.score,
      // Only a hit saves the caller money; an approximate answer still queues a paid generation.
      cost_saved_usd: isHit ? cfg.imagePrice : 0,
      model_used: asset.model_used,
      source: asset.source,
      sizes: { thumb: u.thumb_url, medium: u.medium_url, large: u.url },
      original_url: u.original_url,
      ...(coll ? { collection: coll.id } : {}),
      ...(isHit ? {} : { generation_queued: coll ? false : generationQueued }),
      ...(byokFallbackStatus ? { byok: { status: byokFallbackStatus } } : {}),
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export async function handleKeygen(request: Request, s: Services, genKey: () => string, userId: string): Promise<Response> {
  // Namespaced like `gen:` and `login:ip:` so keygen doesn't share a bucket with other limits.
  const ok = await s.rateLimiter.limit(`keygen:ip:${clientIp(request)}`);
  if (!ok) return Response.json({ error: "Too many key requests" }, { status: 429 });
  let label: string | null = null;
  try { const b: any = await request.json(); if (typeof b?.label === "string") label = b.label.slice(0, 80); } catch { /* body optional */ }
  const key = genKey();
  await s.keys.addKey(await sha256Hex(key), userId, label);
  return Response.json({ key, created_at: Math.floor(Date.now() / 1000) });
}
