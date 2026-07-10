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
