import type { Env, Services, GenerationRow, AssetRow } from "./types";
import { resolveApiPrincipal } from "./session";
import { combinedPrompt } from "./collections";
import { MAX_PROMPT_LEN } from "./handler";
import { startGeneration, driveGeneration, type GenJobsCfg } from "./generation-jobs";
import { assetUrls } from "./asset-urls";

// Soft-parallelism guard: a user may have this many generations in flight at
// once. Mirrored client-side as a pre-check; this server value is authoritative.
export const MAX_CONCURRENT_GENERATIONS = 3;

// Creation surface: session or bearer key, owner-only. Non-owner requests on
// a collection answer 404 (not 403) — the id is a capability for *searching*;
// whether someone else owns it is not disclosed (same as collections-routes).

export function generationView(row: GenerationRow, asset: AssetRow | null, assetBaseUrl?: string) {
  const view: Record<string, unknown> = {
    id: row.id, status: row.status, collection: row.collection_id,
    prompt: row.prompt, created_at: row.created_at,
  };
  if (row.status === "failed" && row.error) view.error = row.error;
  if (row.status === "succeeded" && asset) {
    const u = assetUrls(asset, assetBaseUrl);
    view.image = { id: asset.id, url: u.url, thumb_url: u.thumb_url, medium_url: u.medium_url, original_url: u.original_url };
  }
  return view;
}

export async function handleCreateGeneration(
  collectionId: string, request: Request, env: Env, s: Services, cfg: GenJobsCfg, assetBaseUrl?: string
): Promise<Response> {
  const p = await resolveApiPrincipal(request, env, s);
  if (!p) return Response.json({ error: "login required" }, { status: 401 });
  const coll = await s.collections.get(collectionId);
  if (!coll || coll.owner_user_id !== p.userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  if (!(await s.rateLimiter.limit(`bgen:${p.userId}`))) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  if ((await s.generations.countOpenByUser(p.userId)) >= MAX_CONCURRENT_GENERATIONS) {
    return Response.json({ error: "concurrent_limit", limit: MAX_CONCURRENT_GENERATIONS }, { status: 429 });
  }
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (typeof body?.prompt !== "string" || body.prompt.trim() === "") {
    return Response.json({ error: "prompt required" }, { status: 422 });
  }
  if (body.prompt.length > MAX_PROMPT_LEN) {
    return Response.json({ error: `prompt must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
  }
  const prompt = combinedPrompt(body.prompt, coll.theme_prompt);
  if (prompt.length > MAX_PROMPT_LEN) {
    return Response.json({ error: `prompt plus collection theme must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
  }
  const out = await startGeneration({ userId: p.userId, collectionId: coll.id, prompt }, s, cfg);
  switch (out.kind) {
    case "accepted":
      return Response.json(
        { generation: generationView(out.row, null, assetBaseUrl), byok: { used: out.used, cap: out.cap, est_spend_usd: out.estSpendUsd } },
        { status: 202 }
      );
    case "content_policy":
      return Response.json({ error: "content_policy", category: out.category }, { status: 400 });
    case "cap_reached":
      return Response.json({ error: "monthly cap reached", used: out.used, cap: out.cap }, { status: 429 });
    case "byok_unconfigured":
      return Response.json({ error: "byok required", detail: "add an enabled provider key first" }, { status: 403 });
    case "provider_error":
      return Response.json({ error: "generation failed to start" }, { status: 502 });
  }
}

export async function handleListCollectionGenerations(
  collectionId: string, url: URL, request: Request, env: Env, s: Services
): Promise<Response> {
  const p = await resolveApiPrincipal(request, env, s);
  if (!p) return Response.json({ error: "login required" }, { status: 401 });
  const coll = await s.collections.get(collectionId);
  if (!coll || coll.owner_user_id !== p.userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  const status = url.searchParams.get("status") ?? "pending";
  if (status !== "pending") return Response.json({ error: "unsupported status" }, { status: 400 });
  const rows = await s.generations.listPendingByCollection(collectionId, p.userId, 20);
  return Response.json({
    generations: rows.map((r) => ({ id: r.id, prompt: r.prompt, status: r.status, created_at: r.created_at })),
  });
}

export async function handleGetGeneration(
  id: string, request: Request, env: Env, s: Services, cfg: GenJobsCfg, assetBaseUrl?: string
): Promise<Response> {
  const p = await resolveApiPrincipal(request, env, s);
  if (!p) return Response.json({ error: "login required" }, { status: 401 });
  let row = await s.generations.get(id);
  if (!row || row.user_id !== p.userId) return Response.json({ error: "not found" }, { status: 404 });
  if (row.status === "queued" || row.status === "generating") {
    row = (await driveGeneration(id, s, cfg)) ?? row;
  }
  const asset = row.status === "succeeded" && row.asset_id ? await s.assets.getAsset(row.asset_id) : null;
  // Same usage block shape as the 202 (createInCollection) response, but read
  // fresh here so a post-spend poll reflects the actual month-to-date spend
  // rather than the pre-spend snapshot from the create call.
  const usage = await s.byok.getUsage(row.user_id, row.month);
  const key = await s.byok.get(row.user_id);
  const cap = key ? key.monthly_cap : 0;
  return Response.json({
    generation: generationView(row, asset, assetBaseUrl),
    byok: { used: usage.count, cap, est_spend_usd: usage.est_spend_usd },
  });
}
