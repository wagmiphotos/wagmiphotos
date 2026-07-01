import type { Services } from "./types";
import { similarityFloor } from "./floor";
import { normalizePrompt } from "./normalize";
import { sha256Hex } from "./auth";

export interface GenBody { prompt: string; n?: number; size?: string; cache_tolerance?: number; }
export interface GenCfg { floorSimMax: number; floorSimMin: number; imagePrice: number; now: () => number; }

export async function handleGenerate(body: GenBody, s: Services, cfg: GenCfg): Promise<Response> {
  if (body.n != null && body.n !== 1) {
    return Response.json({ error: "only n=1 is supported" }, { status: 422 });
  }
  const prompt = body.prompt ?? "";
  const tol = body.cache_tolerance ?? 0.15;
  const floor = similarityFloor(tol, cfg.floorSimMax, cfg.floorSimMin);
  const normalized = normalizePrompt(prompt);

  const vec = await s.clip.textEmbed(prompt);
  const matches = await s.vectorize.query(vec, 1);
  const best = matches[0] ?? null;
  const asset = best ? await s.assets.getAsset(best.id) : null;

  // empty pool: nothing to serve
  if (!best || !asset) {
    await s.queries.recordQuery({ normalized, original: prompt, assetId: null, similarity: 0, built: false });
    return Response.json(
      { created: cfg.now(), data: [], shared_cache: { result: "pending", similarity: 0, cost_saved_usd: 0 } },
      { status: 202 }
    );
  }

  const isHit = best.score >= floor;
  const result = isHit ? "hit" : "approximate";
  await s.queries.recordQuery({
    normalized, original: prompt, assetId: asset.id, similarity: best.score, built: isHit,
  });
  return Response.json({
    created: cfg.now(),
    data: [{ url: asset.url }],
    shared_cache: {
      result,
      similarity: best.score,
      cost_saved_usd: cfg.imagePrice,
      model_used: asset.model_used,
      source: asset.source,
      sizes: { thumb: asset.thumb_url, medium: asset.medium_url, large: asset.url },
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export async function handleKeygen(request: Request, s: Services, genKey: () => string): Promise<Response> {
  const ok = await s.rateLimiter.limit(clientIp(request));
  if (!ok) return Response.json({ error: "Too many key requests" }, { status: 429 });
  const key = genKey();
  await s.keys.addKey(await sha256Hex(key));
  return Response.json({ key, created_at: Date.now() });
}
