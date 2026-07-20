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
