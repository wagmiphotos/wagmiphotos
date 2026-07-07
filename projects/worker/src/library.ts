import type { Services, LibraryAssetRow } from "./types";
import { assetUrls } from "./asset-urls";

export interface LibraryCfg { assetBaseUrl?: string; }
export interface LibrarySearchCfg extends LibraryCfg { floorSimMin: number; }

export const SEARCH_TOP_K = 100; // Vectorize topK cap without values/metadata

// The documented public shape for a library image (spec §GET /v1/library).
// Internal columns (source_id, source_url, locally_cached) are intentionally dropped;
// the URL fields are derived (Task 10 / migration 0007).
function publicAsset(r: LibraryAssetRow, baseUrl: string | undefined) {
  const u = assetUrls(r, baseUrl);
  return {
    id: r.id, prompt: r.prompt, thumb_url: u.thumb_url, medium_url: u.medium_url,
    url: u.url, width: r.width, height: r.height, mime: r.mime,
    model_used: r.model_used, source: r.source, created_at: r.created_at,
  };
}

const MAX_Q_LEN = 200;

export async function handleLibrarySearch(url: URL, s: Services, cfg: LibrarySearchCfg): Promise<Response> {
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

  if (q) {
    try {
      const vec = await s.embedder.textEmbed(q);
      const matches = await s.vectorize.query(vec, SEARCH_TOP_K);
      const relevant = matches.filter((m) => m.score >= cfg.floorSimMin);
      const page = relevant.slice(offset, offset + limit);
      const rows = await s.assets.getAssetsByIds(page.map((m) => m.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const images = page.flatMap((m) => {
        const r = byId.get(m.id);
        return r ? [publicAsset(r, cfg.assetBaseUrl)] : []; // orphan vector: skip
      });
      return Response.json({ images, has_more: relevant.length > offset + limit });
    } catch (e) {
      // Workers AI / Vectorize unavailable (offline dev) or transient failure:
      // degrade to the LIKE scan rather than 500ing the library page.
      console.warn("semantic library search failed; falling back to LIKE", e);
    }
  }

  // browse (empty q) and fallback path: existing searchAssets LIKE + recency code
  const rows = await s.assets.searchAssets({ q, limit: limit + 1, offset });
  const has_more = rows.length > limit;
  return Response.json({ images: rows.slice(0, limit).map((r) => publicAsset(r, cfg.assetBaseUrl)), has_more });
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
