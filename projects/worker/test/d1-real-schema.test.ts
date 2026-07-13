import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";
import { realDb } from "./real-d1";

function seedUser(db: any, id = "usr_1") {
  db._raw.exec(`INSERT INTO users (id, email) VALUES ('${id}', '${id}@example.com')`);
}

it("insertGenerated writes a row the REAL schema accepts and live_assets exposes", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_1", ownerUserId: "usr_1", name: "Foxes", themePrompt: "watercolor" });
  await assets.insertGenerated({
    id: "a1", prompt: "a red fox", sourceUrl: "https://byok.example/byok/a1/original.webp",
    mime: "image/webp", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai",
    priceUsd: 0.04, createdBy: "usr_1", collectionId: "col_1",
  });
  const row = await assets.getAsset("a1");
  expect(row?.id).toBe("a1");
  const listed = await assets.listByCollection({ collectionId: "col_1", limit: 10, offset: 0 });
  expect(listed.map((r) => r.id)).toEqual(["a1"]);
});

it("unscoped searchAssets excludes collection assets (shared library is operator-curated)", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_x", ownerUserId: "usr_1", name: "n", themePrompt: "" });
  await assets.insertGenerated({ id: "pub1", prompt: "green fox", sourceUrl: "https://x/1.webp", mime: "image/webp", width: 1024, height: 1024, modelUsed: "m", provider: "openai", priceUsd: 0.04, createdBy: "usr_1", collectionId: null });
  await assets.insertGenerated({ id: "col1", prompt: "green fox scoped", sourceUrl: "https://x/2.webp", mime: "image/webp", width: 1024, height: 1024, modelUsed: "m", provider: "openai", priceUsd: 0.04, createdBy: "usr_1", collectionId: "col_x" });
  const unscoped = await assets.searchAssets({ q: "green fox", limit: 10, offset: 0 });
  expect(unscoped.map((r) => r.id)).toEqual(["pub1"]);
  const scoped = await assets.searchAssets({ q: "green fox", limit: 10, offset: 0, collectionId: "col_x" });
  expect(scoped.map((r) => r.id)).toEqual(["col1"]);
});

it("tombstoneAsset hides the row from every live_assets read", async () => {
  const db = realDb();
  seedUser(db);
  const { assets } = makeD1Stores(db);
  await assets.insertGenerated({
    id: "a2", prompt: "a blue fox", sourceUrl: "https://byok.example/byok/a2/original.webp",
    mime: "image/webp", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai",
    priceUsd: 0.04, createdBy: "usr_1", collectionId: null,
  });
  await assets.tombstoneAsset("a2");
  expect(await assets.getAsset("a2")).toBeNull();
});

it("byok reserve/refund round-trips against the real byok_usage schema", async () => {
  const db = realDb();
  seedUser(db);
  const { byok } = makeD1Stores(db);
  expect(await byok.reserve("usr_1", "2026-07", 2)).toBe(true);
  expect(await byok.reserve("usr_1", "2026-07", 2)).toBe(true);
  expect(await byok.reserve("usr_1", "2026-07", 2)).toBe(false); // cap spent
  await byok.refund("usr_1", "2026-07");
  expect((await byok.getUsage("usr_1", "2026-07")).count).toBe(1);
  expect(await byok.totalGenerated("usr_1")).toBe(1);
});

import type { GenerationRow } from "../src/types";

function seedGeneration(db: any) {
  seedUser(db);
  db._raw.exec(`INSERT INTO collections (id, owner_user_id, name, theme_prompt) VALUES ('col_g', 'usr_1', 'n', '')`);
}

it("generations: create -> setProviderJob -> succeed round-trips on the real schema", async () => {
  const db = realDb();
  seedGeneration(db);
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "gen_1", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  await generations.setProviderJob("gen_1", "req-9");
  let row = (await generations.get("gen_1")) as GenerationRow;
  expect(row.status).toBe("generating");
  expect(row.provider_job_id).toBe("req-9");
  expect(await generations.succeed("gen_1", "asset-1")).toBe(true);
  expect(await generations.succeed("gen_1", "asset-1")).toBe(false); // second transition loses
  row = (await generations.get("gen_1")) as GenerationRow;
  expect(row.status).toBe("succeeded");
  expect(row.asset_id).toBe("asset-1");
});

it("generations: fail transitions once (the refund guard) and claim is exclusive", async () => {
  const db = realDb();
  seedGeneration(db);
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "gen_2", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  expect(await generations.claim("gen_2")).toBe(true);
  expect(await generations.claim("gen_2")).toBe(false); // fresh claim blocks a second driver
  await generations.release("gen_2");
  expect(await generations.claim("gen_2")).toBe(true);  // released -> reclaimable
  expect(await generations.fail("gen_2", "boom")).toBe(true);
  expect(await generations.fail("gen_2", "boom")).toBe(false);
  expect(await generations.claim("gen_2")).toBe(false); // terminal rows are unclaimable
  const row = (await generations.get("gen_2"))!;
  expect(row.error).toBe("boom");
  expect(row.attempts).toBe(2);
});

it("generations: listStale returns only stale open jobs", async () => {
  const db = realDb();
  seedGeneration(db);
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "gen_3", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  expect((await generations.listStale(120, 10)).length).toBe(0); // too fresh
  db._raw.exec(`UPDATE generations SET updated_at = datetime('now', '-10 minutes') WHERE id = 'gen_3'`);
  expect((await generations.listStale(120, 10)).map((r: any) => r.id)).toEqual(["gen_3"]);
});

it("generations: collection_id has no FK to collections — deleting a collection with a succeeded generation does not throw, and the generation row survives (0016 fix)", async () => {
  const db = realDb();
  seedGeneration(db); // seeds usr_1 + collection col_g
  const { generations, collections } = makeD1Stores(db);
  await generations.create({ id: "gen_fk1", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  expect(await generations.succeed("gen_fk1", "asset-fk1")).toBe(true);
  await expect(collections.delete("col_g")).resolves.not.toThrow();
  expect(await collections.get("col_g")).toBeNull();
  const row = await generations.get("gen_fk1");
  expect(row).not.toBeNull(); // generation rows are billing/audit history: they outlive the collection
  expect(row!.status).toBe("succeeded");
  expect(row!.collection_id).toBe("col_g"); // stale reference on purpose, not cleared
});

it("browse + bumpSearchCount + previews work on the real schema (0017; window fn, LIKE escape)", async () => {
  const db = realDb();
  seedUser(db);
  seedUser(db, "usr_2");
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_a", ownerUserId: "usr_1", name: "Retro posters", themePrompt: "" });
  await collections.create({ id: "col_b", ownerUserId: "usr_2", name: "100%_wild", themePrompt: "" });
  for (let i = 0; i < 5; i++) {
    await assets.insertGenerated({
      id: `a${i}`, prompt: `p${i}`, sourceUrl: `https://x/a${i}.png`, mime: "image/png",
      width: 1, height: 1, modelUsed: "m", provider: "openai", priceUsd: 0.01, createdBy: "usr_1", collectionId: "col_a",
    });
  }
  await assets.bumpServeCount("a0");
  await collections.bumpSearchCount("col_a");

  const rows = await collections.browse({ q: "", limit: 10, offset: 0 });
  expect(rows.map((r) => r.id)).toEqual(["col_a", "col_b"]); // most served first
  expect(rows[0]).toMatchObject({ image_count: 5, total_serves: 1, search_count: 1 });

  const previews = await assets.previewsByCollections(["col_a", "col_b"], 4);
  expect(previews.filter((p) => p.collection_id === "col_a").length).toBe(4); // capped per collection
  expect(previews.filter((p) => p.collection_id === "col_b").length).toBe(0);
  expect(await assets.previewsByCollections([], 4)).toEqual([]);

  // a literal % or _ in the name filter must not act as a wildcard
  expect((await collections.browse({ q: "100%_", limit: 10, offset: 0 })).map((r) => r.id)).toEqual(["col_b"]);
  expect((await collections.browse({ q: "0%w", limit: 10, offset: 0 })).length).toBe(0);
  expect((await collections.browse({ q: "zzz", limit: 10, offset: 0 })).length).toBe(0);

  // owner list now carries search_count too
  expect((await collections.listByOwner("usr_1"))[0].search_count).toBe(1);
});

it("generations: countOpenByUser + listPendingByCollection are owner+status scoped (real schema)", async () => {
  const db = realDb();
  seedUser(db, "usr_1");
  seedUser(db, "usr_2");
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "g1", userId: "usr_1", collectionId: "col_a", prompt: "p1", provider: "gmicloud", month: "2026-07" });
  await generations.create({ id: "g2", userId: "usr_1", collectionId: "col_a", prompt: "p2", provider: "gmicloud", month: "2026-07" });
  await generations.create({ id: "g3", userId: "usr_1", collectionId: "col_a", prompt: "p3", provider: "gmicloud", month: "2026-07" });
  await generations.succeed("g3", "asset-3");                 // terminal — excluded
  await generations.create({ id: "g4", userId: "usr_1", collectionId: "col_b", prompt: "p4", provider: "gmicloud", month: "2026-07" });
  await generations.create({ id: "g5", userId: "usr_2", collectionId: "col_a", prompt: "p5", provider: "gmicloud", month: "2026-07" });

  expect(await generations.countOpenByUser("usr_1")).toBe(3); // g1,g2 open + g4 open; g3 succeeded, g5 other user
  const pend = await generations.listPendingByCollection("col_a", "usr_1", 20);
  expect(pend.map((r) => r.id).sort()).toEqual(["g1", "g2"]); // col_a + usr_1 + open only
  // order (newest first): force g1 older so the DESC sort is deterministic (created_at is second-resolution)
  db._raw.exec(`UPDATE generations SET created_at = datetime('now','-1 minute') WHERE id = 'g1'`);
  const ordered = await generations.listPendingByCollection("col_a", "usr_1", 20);
  expect(ordered.map((r) => r.id)).toEqual(["g2", "g1"]);
});
