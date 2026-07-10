import type { Services, AssetRow, Match, CollectionRow } from "./types";
import { similarityFloor } from "./floor";
import { normalizePrompt } from "./normalize";
import { sha256Hex } from "./auth";
import { assetUrls } from "./asset-urls";
import { combinedPrompt } from "./collections";

export interface GenBody { prompt: string; n?: number; size?: string; collection?: string; }
export interface GenCfg { floorSimMax: number; floorSimMin: number; imagePrice: number; now: () => number; assetBaseUrl?: string; }

/** Default cache_tolerance (contract.json: default_cache_tolerance). */
export const DEFAULT_CACHE_TOLERANCE = 0.15;
export const MAX_PROMPT_LEN = 2000;

// Orphan vectors are possible when the backfill's D1 insert fails after the
// Vectorize upsert; fetching a few candidates lets one orphan not hide the cache.
const QUERY_TOP_K = 3;

// Best-effort owner-facing stat: only hit/approximate returns count ("matched
// and returned"), never the initial generated response and never library reads.
async function bumpServed(s: Services, assetId: string): Promise<void> {
  try { await s.assets.bumpServeCount(assetId); } catch (e) { console.error("bumpServeCount failed", e); }
}

export async function handleGenerate(
  body: GenBody, s: Services, cfg: GenCfg
): Promise<Response> {
  if (body.n != null && body.n !== 1) {
    return Response.json({ error: "only n=1 is supported" }, { status: 422 });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return Response.json({ error: "prompt must be a non-empty string" }, { status: 422 });
  }
  if (body.prompt.length > MAX_PROMPT_LEN) {
    return Response.json({ error: `prompt must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
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
  const floor = similarityFloor(DEFAULT_CACHE_TOLERANCE, cfg.floorSimMax, cfg.floorSimMin);
  const normalized = normalizePrompt(prompt);

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
    let generationQueued = false;
    if (!coll) {
      try {
        generationQueued = await s.queries.recordQuery({
          normalized, original: prompt, assetId: null, similarity: 0, built: false, generate: true,
        });
      } catch (e) { console.error("recordQuery failed", e); } // demand write failed: nothing queued
    }
    return Response.json(
      {
        created: cfg.now(), data: [],
        shared_cache: {
          result: "pending", similarity: 0, cost_saved_usd: 0,
          ...(coll ? { collection: coll.id, generation_queued: false } : { generation_queued: generationQueued }),
        },
      },
      { status: 202 }
    );
  }

  const isHit = best.score >= floor;
  const result = isHit ? "hit" : "approximate";
  let generationQueued = false;
  if (!coll) {
    try {
      generationQueued = await s.queries.recordQuery({
        normalized, original: prompt, assetId: asset.id, similarity: best.score, built: isHit, generate: true,
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
