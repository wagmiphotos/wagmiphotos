import type { Services, LibraryAssetRow, CollectionRow } from "./types";
import { assetUrls } from "./asset-urls";
import { combinedPrompt } from "./collections";

export interface LibraryCfg { assetBaseUrl?: string; }
export interface LibrarySearchCfg extends LibraryCfg { floorSimMin: number; }

export const SEARCH_TOP_K = 100; // Vectorize topK cap without values/metadata

// The documented public shape for a library image (spec §GET /v1/library).
// source_id and locally_cached stay internal; source_url is deliberately
// public as original_url (spec 2026-07-07-large-cap-original-url-design.md).
// The URL fields are derived (Task 10 / migration 0007). like_count is always
// present; liked is only attached when the request is authenticated.
function publicAsset(r: LibraryAssetRow, baseUrl: string | undefined, liked?: boolean) {
  const u = assetUrls(r, baseUrl);
  return {
    id: r.id, prompt: r.prompt, thumb_url: u.thumb_url, medium_url: u.medium_url,
    url: u.url, width: r.width, height: r.height, mime: r.mime,
    model_used: r.model_used, source: r.source, created_at: r.created_at,
    original_url: u.original_url, like_count: r.like_count,
    ...(liked === undefined ? {} : { liked }),
  };
}

const MAX_Q_LEN = 200;

export async function handleLibrarySearch(
  url: URL, s: Services, cfg: LibrarySearchCfg, userId?: string | null
): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_Q_LEN) {
    return Response.json({ error: `q must be at most ${MAX_Q_LEN} characters` }, { status: 400 });
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
    if (!Number.isInteger(n) || n < 0) {
      return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    }
    offset = n;
  }

  const sortParam = url.searchParams.get("sort");
  const sort: "match" | "liked" = sortParam === "match" || sortParam === "liked" ? sortParam : (q ? "match" : "liked");

  let coll: CollectionRow | null = null;
  const collectionId = url.searchParams.get("collection");
  if (collectionId) {
    coll = await s.collections.get(collectionId);
    if (!coll) return Response.json({ error: "unknown collection" }, { status: 404 });
    // Best-effort browse/owner stat: every scoped read counts as a "search".
    try { await s.collections.bumpSearchCount(coll.id); } catch (e) { console.error("bumpSearchCount failed", e); }
  }

  // Project rows to the public shape, attaching the per-user `liked` flag when authed.
  const project = async (rows: LibraryAssetRow[], has_more: boolean): Promise<Response> => {
    let likedSet: Set<string> | null = null;
    if (userId) likedSet = new Set(await s.assets.likedByUser(userId, rows.map((r) => r.id)));
    const images = rows.map((r) => publicAsset(r, cfg.assetBaseUrl, likedSet ? likedSet.has(r.id) : undefined));
    return Response.json({ images, has_more });
  };

  if (q) {
    try {
      const vec = await s.embedder.textEmbed(coll ? combinedPrompt(q, coll.theme_prompt) : q);
      const matches = coll
        ? await s.vectorize.queryNamespace(vec, coll.id, SEARCH_TOP_K)
        : await s.vectorize.query(vec, SEARCH_TOP_K);
      const relevant = matches.filter((m) => m.score >= cfg.floorSimMin);

      if (sort === "liked") {
        // Hydrate the whole relevant set, order by like_count, then paginate.
        const rows = await s.assets.getAssetsByIds(relevant.map((m) => m.id));
        rows.sort((a, b) => b.like_count - a.like_count || (a.id < b.id ? -1 : 1));
        return await project(rows.slice(offset, offset + limit), rows.length > offset + limit);
      }
      const page = relevant.slice(offset, offset + limit);
      const rows = await s.assets.getAssetsByIds(page.map((m) => m.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = page.flatMap((m) => (byId.has(m.id) ? [byId.get(m.id)!] : [])); // orphan vector: skip
      return await project(ordered, relevant.length > offset + limit);
    } catch (e) {
      // Workers AI / Vectorize unavailable (offline dev) or transient failure:
      // degrade to the LIKE scan rather than 500ing the library page.
      console.warn("semantic library search failed; falling back to LIKE", e);
    }
  }

  // Empty q -> likes-ranked browse; q-present fallback -> LIKE scan (existing behavior).
  const rows = q
    ? await s.assets.searchAssets({ q, limit: limit + 1, offset, ...(coll ? { collectionId: coll.id } : {}) })
    : await s.assets.browseByLikes({ limit: limit + 1, offset, ...(coll ? { collectionId: coll.id } : {}) });
  return await project(rows.slice(0, limit), rows.length > limit);
}

export async function handleLikeAsset(id: string, userId: string, s: Services): Promise<Response> {
  if (!(await s.assets.getAsset(id))) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ liked: true, like_count: await s.assets.likeAsset(userId, id) });
}

export async function handleUnlikeAsset(id: string, userId: string, s: Services): Promise<Response> {
  if (!(await s.assets.getAsset(id))) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ liked: false, like_count: await s.assets.unlikeAsset(userId, id) });
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function assetFilename(
  asset: { id: string; prompt: string; mime: string | null },
  contentType: string | null
): string {
  const slug = asset.prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const mime = (contentType ?? asset.mime ?? "").split(";")[0].trim();
  const ext = MIME_EXT[mime] ?? "bin";
  return `${slug || asset.id}.${ext}`;
}

export async function handleLibraryDownload(
  id: string,
  s: Services,
  cfg: LibraryCfg,
  fetchFn: (url: string) => Promise<Response>
): Promise<Response> {
  const asset = await s.assets.getAsset(id);
  if (!asset) return Response.json({ error: "not found" }, { status: 404 });

  const u = assetUrls(asset, cfg.assetBaseUrl);
  let upstream: Response;
  try {
    upstream = await fetchFn(u.url);
  } catch {
    return Response.json({ error: "upstream fetch failed" }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: "upstream fetch failed" }, { status: 502 });

  const contentType = upstream.headers.get("content-type");
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType ?? asset.mime ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${assetFilename(asset, contentType)}"`,
    },
  });
}
