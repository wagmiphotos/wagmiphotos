import type { Env, Services } from "./types";
import { resolveApiPrincipal } from "./session";
import {
  newCollectionId, validateCollectionFields, collectionView, MAX_COLLECTIONS_PER_USER,
} from "./collections";
import { assetUrls } from "./asset-urls";

// Management surface: session or bearer key (resolveApiPrincipal), owner-scoped.
// Non-owner requests on a specific collection answer 404 (not 403): the id is
// a capability for *searching*; whether someone else owns it is not disclosed.

async function auth(request: Request, env: Env, s: Services): Promise<string | null> {
  const p = await resolveApiPrincipal(request, env, s);
  return p ? p.userId : null;
}

export async function handleCreateCollection(request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  // Valid BYOK = an enabled key row: creation is pointless without a generation path.
  const byok = await s.byok.get(userId);
  if (!byok || !byok.enabled) return Response.json({ error: "byok required", detail: "add an enabled provider key first" }, { status: 403 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const fields = validateCollectionFields(body, false);
  if ("error" in fields) return Response.json({ error: fields.error }, { status: 422 });

  if ((await s.collections.countByOwner(userId)) >= MAX_COLLECTIONS_PER_USER) {
    return Response.json({ error: "collection limit reached", limit: MAX_COLLECTIONS_PER_USER }, { status: 409 });
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
  return Response.json({ collections: rows.map(collectionView) });
}

export async function handlePatchCollection(id: string, request: Request, env: Env, s: Services): Promise<Response> {
  const userId = await auth(request, env, s);
  if (!userId) return Response.json({ error: "login required" }, { status: 401 });
  const row = await s.collections.get(id);
  if (!row || row.owner_user_id !== userId) return Response.json({ error: "unknown collection" }, { status: 404 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const fields = validateCollectionFields(body, true);
  if ("error" in fields) return Response.json({ error: fields.error }, { status: 422 });

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
