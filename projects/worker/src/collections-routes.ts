import type { Env, Services, ByokRow } from "./types";
import { resolveApiPrincipal } from "./session";
import {
  newCollectionId, validateCollectionFields, collectionView, MAX_COLLECTIONS_PER_USER, requiredGenerationsFor,
} from "./collections";
import { assetUrls } from "./asset-urls";
import { deniedTerm } from "./denylist";
import { moderationFlagged } from "./moderation";
import { decryptSecret } from "./crypto";

// Management surface: session or bearer key (resolveApiPrincipal), owner-scoped.
// Non-owner requests on a specific collection answer 404 (not 403): the id is
// a capability for *searching*; whether someone else owns it is not disclosed.
// Names and themes are shown on the public browse tab, so create/patch runs
// them through the same guardrail as generation prompts (denylist + OpenAI
// moderation, fail-closed).

export interface CollModCfg { kek?: string; moderationKey?: string; fetchFn?: typeof fetch; }

async function auth(request: Request, env: Env, s: Services): Promise<string | null> {
  const p = await resolveApiPrincipal(request, env, s);
  return p ? p.userId : null;
}

/** Null when the text is acceptable; otherwise the error Response to return.
 *  Same key selection as generation: openai users moderate with their own
 *  key (the endpoint is free), others need the operator OPENAI_API_KEY. */
async function nameContentCheck(
  text: string, byok: ByokRow | null, cfg: CollModCfg
): Promise<Response | null> {
  const term = deniedTerm(text);
  if (term) return Response.json({ error: "content_policy", category: `denylist:${term}` }, { status: 422 });
  let modKey = cfg.moderationKey;
  if (byok && byok.enabled && byok.provider === "openai" && cfg.kek) {
    try { modKey = await decryptSecret(byok.key_ciphertext, cfg.kek); }
    catch (e) { console.error("collection moderation decrypt failed", e); }
  }
  if (!modKey) return Response.json({ error: "moderation unavailable" }, { status: 503 });
  let category: string | null;
  try { category = await moderationFlagged(text, modKey, cfg.fetchFn ?? fetch); }
  catch (e) {
    console.error("collection name moderation failed", e);
    return Response.json({ error: "moderation unavailable" }, { status: 503 }); // fail closed
  }
  if (category) return Response.json({ error: "content_policy", category }, { status: 422 });
  return null;
}

export async function handleCreateCollection(request: Request, env: Env, s: Services, cfg: CollModCfg = {}): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  // Valid BYOK = an enabled key row: creation is pointless without a generation path.
  const byok = await s.byok.get(userId);
  if (!byok || !byok.enabled) return Response.json({ error: "byok required", detail: "add an enabled provider key first" }, { status: 403 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const fields = validateCollectionFields(body, false);
  if ("error" in fields) return Response.json({ error: fields.error }, { status: 422 });

  const blocked = await nameContentCheck([fields.name, fields.themePrompt].filter(Boolean).join("\n"), byok, cfg);
  if (blocked) return blocked;

  const existing = await s.collections.countByOwner(userId);
  if (existing >= MAX_COLLECTIONS_PER_USER) {
    return Response.json({ error: "collection limit reached", limit: MAX_COLLECTIONS_PER_USER }, { status: 409 });
  }
  // Progressive slots (spec 2026-07-09-collection-slots-design.md): the nth
  // collection needs 10^(n-1) lifetime generations. byok_usage sums are
  // monotonic — deleting images/collections/keys never re-locks a slot.
  const required = requiredGenerationsFor(existing + 1);
  if (required > 0) {
    const generated = await s.byok.totalGenerated(userId);
    if (generated < required) {
      return Response.json({ error: "collection slot locked", required, generated }, { status: 409 });
    }
  }
  const id = newCollectionId();
  await s.collections.create({ id, ownerUserId: userId, name: fields.name!, themePrompt: fields.themePrompt ?? "" });
  const row = await s.collections.get(id);
  return Response.json({ collection: collectionView(row!) });
}

export async function handleListCollections(request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const rows = await s.collections.listByOwner(userId);
  const generated = await s.byok.totalGenerated(userId);
  return Response.json({
    collections: rows.map(collectionView),
    slots: { used: rows.length, generated, next_required: requiredGenerationsFor(rows.length + 1) },
  });
}

// Public directory (2026-07-10 decision): every collection is listable — the
// browse tab supersedes unlisted-by-ID sharing. Owner identity still never
// leaves the server; previews reuse the public library asset shape.
const BROWSE_MAX_Q = 80; // = MAX_COLLECTION_NAME_LEN; longer can't match anything
const BROWSE_PREVIEWS = 4;

export async function handleBrowseCollections(
  url: URL, request: Request, env: Env, s: Services, cfg: { assetBaseUrl?: string }
): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length > BROWSE_MAX_Q) {
    return Response.json({ error: `q must be at most ${BROWSE_MAX_Q} characters` }, { status: 400 });
  }
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  let limit = 24;
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n)) return Response.json({ error: "limit must be an integer" }, { status: 400 });
    limit = Math.min(60, Math.max(1, n));
  }
  let offset = 0;
  if (rawOffset != null) {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    offset = n;
  }

  const rows = await s.collections.browse({ q, limit: limit + 1, offset });
  const page = rows.slice(0, limit);
  const previews = await s.assets.previewsByCollections(page.map((c) => c.id), BROWSE_PREVIEWS);
  const byColl = new Map<string, { thumb_url: string | null; medium_url: string | null; url: string; prompt: string }[]>();
  for (const p of previews) {
    const u = assetUrls(p, cfg.assetBaseUrl);
    const list = byColl.get(p.collection_id) ?? [];
    list.push({ thumb_url: u.thumb_url, medium_url: u.medium_url, url: u.url, prompt: p.prompt });
    byColl.set(p.collection_id, list);
  }
  return Response.json({
    collections: page.map((c) => ({ ...collectionView(c), previews: byColl.get(c.id) ?? [] })),
    has_more: rows.length > limit,
  });
}

export async function handlePatchCollection(id: string, request: Request, env: Env, s: Services, cfg: CollModCfg = {}): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const fields = validateCollectionFields(body, true);
  if ("error" in fields) return Response.json({ error: fields.error }, { status: 422 });

  const changed = [fields.name, fields.themePrompt].filter((v) => v != null && v !== "").join("\n");
  if (changed) {
    const blocked = await nameContentCheck(changed, await s.byok.get(userId), cfg);
    if (blocked) return blocked;
  }

  await s.collections.patch(id, fields);
  const updated = await s.collections.get(id);
  return Response.json({ collection: collectionView(updated!) });
}

// Chunk best-effort vector deletes so one huge collection can't blow a single
// Vectorize mutation; failures log and move on (D1 tombstone is authoritative).
const VECTOR_DELETE_CHUNK = 100;
async function deleteVectors(s: Services, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTOR_DELETE_CHUNK) {
    try { await s.vectorize.deleteByIds(ids.slice(i, i + VECTOR_DELETE_CHUNK)); }
    catch (e) { console.error("collection vector delete failed", e); }
  }
}

export async function handleListCollectionImages(
  id: string, url: URL, request: Request, env: Env, s: Services, cfg: { assetBaseUrl?: string }
): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });

  // Same limit/offset semantics and caps as /v1/library.
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  let limit = 24;
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n)) return Response.json({ error: "limit must be an integer" }, { status: 400 });
    limit = Math.min(60, Math.max(1, n));
  }
  let offset = 0;
  if (rawOffset != null) {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    offset = n;
  }
  const rows = await s.assets.listByCollection({ collectionId: id, limit: limit + 1, offset });
  const page = rows.slice(0, limit);
  const images = page.map((r) => {
    const u = assetUrls(r, cfg.assetBaseUrl);
    return {
      id: r.id, prompt: r.prompt, thumb_url: u.thumb_url, medium_url: u.medium_url,
      url: u.url, width: r.width, height: r.height, mime: r.mime,
      model_used: r.model_used, source: r.source, created_at: r.created_at,
      original_url: u.original_url,
      serve_count: r.serve_count, // owner-only stat; never on public library shapes
    };
  });
  return Response.json({ images, has_more: rows.length > limit });
}

export async function handleDeleteCollectionImage(
  collectionId: string, assetId: string, request: Request, env: Env, s: Services
): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(collectionId);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  const member = await s.assets.getCollectionMember(assetId, collectionId);
  if (!member) return Response.json({ error: "not found" }, { status: 404 });
  await s.assets.tombstoneAsset(assetId); // authoritative
  await deleteVectors(s, [assetId]);      // best-effort hygiene
  return Response.json({ status: "ok" });
}

export async function handleDeleteCollection(id: string, request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  // Order: tombstone (authoritative) -> vectors (best-effort) -> row delete.
  // A crash mid-way leaves tombstoned assets + a live row; re-running is idempotent.
  const ids = await s.assets.tombstoneByCollection(id);
  await deleteVectors(s, ids);
  await s.collections.delete(id);
  return Response.json({ status: "ok", images_deleted: ids.length });
}
