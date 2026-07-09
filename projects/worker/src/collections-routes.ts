import type { Env, Services } from "./types";
import { resolveApiPrincipal } from "./session";
import {
  newCollectionId, validateCollectionFields, collectionView, MAX_COLLECTIONS_PER_USER,
} from "./collections";

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
