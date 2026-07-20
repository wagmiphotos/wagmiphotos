import type { Services } from "./types";
import type { LibraryCfg } from "./library";
import { assetUrls } from "./asset-urls";

export const SHOWCASE_LIMIT = 8;
export const HOME_CACHE_SECONDS = 86400; // daily — spec 2026-07-21

// Landing-page payload: live public-library count + top-liked rehosted
// showcase. Public and cached for a day (index.ts adds the caches.default
// layer), so D1 sees roughly one query per colo per day.
export async function handleHome(s: Services, cfg: LibraryCfg): Promise<Response> {
  const [image_count, rows] = await Promise.all([
    s.assets.countLibraryAssets(),
    s.assets.showcaseAssets(SHOWCASE_LIMIT),
  ]);
  const showcase = rows.map((r) => {
    const u = assetUrls(r, cfg.assetBaseUrl);
    return { id: r.id, thumb_url: u.thumb_url, medium_url: u.medium_url, prompt: r.prompt, like_count: r.like_count };
  });
  return Response.json({ image_count, showcase }, {
    headers: { "Cache-Control": `public, max-age=${HOME_CACHE_SECONDS}` },
  });
}
