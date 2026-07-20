import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";
import { realDb } from "./real-d1";

function seedUser(db: any, id = "usr_1") {
  db._raw.exec(`INSERT INTO users (id, email) VALUES ('${id}', '${id}@example.com')`);
}

// Insert a public-library row via the one real write path, then shape it with
// raw SQL (insertGenerated always writes locally_cached=0 / like_count=0).
async function seedAsset(db: any, assets: any, id: string, over: { cached?: number; likes?: number; collectionId?: string | null } = {}) {
  await assets.insertGenerated({
    id, prompt: `p-${id}`, sourceUrl: `https://x/${id}.webp`, mime: "image/webp",
    width: 1024, height: 1024, modelUsed: "m", provider: "openai", priceUsd: 0.04,
    createdBy: "usr_1", collectionId: over.collectionId ?? null,
  });
  if (over.cached) db._raw.exec(`UPDATE assets SET locally_cached = 1 WHERE id = '${id}'`);
  if (over.likes) db._raw.exec(`UPDATE assets SET like_count = ${over.likes} WHERE id = '${id}'`);
}

it("countLibraryAssets: counts live public rows; excludes tombstoned and collection assets", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_1", ownerUserId: "usr_1", name: "n", themePrompt: "" });
  await seedAsset(db, assets, "pub1");
  await seedAsset(db, assets, "pub2");
  await seedAsset(db, assets, "dead", {});
  await seedAsset(db, assets, "scoped", { collectionId: "col_1" });
  await assets.tombstoneAsset("dead");
  expect(await assets.countLibraryAssets()).toBe(2);
});

it("showcaseAssets: cached-only, like-ranked, newest tiebreak, collection/tombstone excluded, limit respected", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_1", ownerUserId: "usr_1", name: "n", themePrompt: "" });
  await seedAsset(db, assets, "hot", { cached: 1, likes: 5 });
  await seedAsset(db, assets, "warm", { cached: 1, likes: 2 });
  await seedAsset(db, assets, "plain_a", { cached: 1 });
  await seedAsset(db, assets, "plain_b", { cached: 1 });
  await seedAsset(db, assets, "uncached_liked", { likes: 9 });          // not rehosted -> excluded
  await seedAsset(db, assets, "scoped", { cached: 1, likes: 9, collectionId: "col_1" }); // excluded
  await seedAsset(db, assets, "dead", { cached: 1, likes: 9 });
  await assets.tombstoneAsset("dead");
  // Deterministic created_at, newest-first among the unliked pair.
  db._raw.exec("UPDATE assets SET created_at = '2026-07-01 00:00:00' WHERE id = 'plain_a'");
  db._raw.exec("UPDATE assets SET created_at = '2026-07-02 00:00:00' WHERE id = 'plain_b'");

  const rows = await assets.showcaseAssets(3);
  expect(rows.map((r) => r.id)).toEqual(["hot", "warm", "plain_b"]);

  const all = await assets.showcaseAssets(8);
  expect(all.map((r) => r.id)).toEqual(["hot", "warm", "plain_b", "plain_a"]);
});

import { handleHome, SHOWCASE_LIMIT, HOME_CACHE_SECONDS } from "../src/home";
import { fakeServices } from "./fakes";
import type { LibraryAssetRow } from "../src/types";

const BASE = "https://cdn.example.com";
const homeCfg = { assetBaseUrl: BASE };

function libRow(over: Partial<LibraryAssetRow> = {}): LibraryAssetRow {
  return { id: "a1", prompt: "a fox", source: "pd12m", source_id: null,
    model_used: "flux", width: 10, height: 20, like_count: 0,
    mime: "image/webp", source_url: null, locally_cached: 1, created_at: "2026-07-03 00:00:00", ...over };
}

it("home: returns image_count and the documented showcase shape, nothing internal", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow());
  const res = await handleHome(s, homeCfg);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.image_count).toBe(1);
  expect(j.showcase).toHaveLength(1);
  expect(j.showcase[0]).toEqual({
    id: "a1", thumb_url: `${BASE}/assets/a1/thumb.webp`, medium_url: `${BASE}/assets/a1/medium.webp`,
    prompt: "a fox", like_count: 0,
  });
});

it("home: counts uncached rows but never showcases them", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow({ id: "cached", locally_cached: 1 }));
  (s as any)._libraryRows.push(libRow({ id: "raw", locally_cached: 0 }));
  const j: any = await (await handleHome(s, homeCfg)).json();
  expect(j.image_count).toBe(2);
  expect(j.showcase.map((x: any) => x.id)).toEqual(["cached"]);
});

it("home: caps the showcase at SHOWCASE_LIMIT", async () => {
  const s = fakeServices();
  for (let i = 0; i < SHOWCASE_LIMIT + 3; i++) (s as any)._libraryRows.push(libRow({ id: "a" + i }));
  const j: any = await (await handleHome(s, homeCfg)).json();
  expect(j.showcase).toHaveLength(SHOWCASE_LIMIT);
});

it("home: sends the daily public cache header", async () => {
  const res = await handleHome(fakeServices(), homeCfg);
  expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${HOME_CACHE_SECONDS}`);
});
