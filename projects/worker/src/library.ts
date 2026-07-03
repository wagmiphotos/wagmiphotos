import type { Services } from "./types";

export async function handleLibrarySearch(url: URL, s: Services): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");

  let limit = 24;
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n)) return Response.json({ error: "limit must be a number" }, { status: 400 });
    limit = Math.min(60, Math.max(1, Math.floor(n)));
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
  return Response.json({ images: rows.slice(0, limit), has_more });
}
