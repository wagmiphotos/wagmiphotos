import type { Services, LibraryAssetRow } from "./types";

// The documented public shape for a library image (spec §GET /v1/library).
// Internal columns (source_id, source_url, locally_cached) are intentionally dropped.
function publicAsset(r: LibraryAssetRow) {
  return {
    id: r.id, prompt: r.prompt, thumb_url: r.thumb_url, medium_url: r.medium_url,
    url: r.url, width: r.width, height: r.height, mime: r.mime,
    model_used: r.model_used, source: r.source, created_at: r.created_at,
  };
}

const MAX_Q_LEN = 200;

export async function handleLibrarySearch(url: URL, s: Services): Promise<Response> {
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

  const rows = await s.assets.searchAssets({ q, limit: limit + 1, offset });
  const has_more = rows.length > limit;
  return Response.json({ images: rows.slice(0, limit).map(publicAsset), has_more });
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
  fetchFn: (url: string) => Promise<Response>
): Promise<Response> {
  const asset = await s.assets.getAsset(id);
  if (!asset) return Response.json({ error: "not found" }, { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetchFn(asset.url);
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
