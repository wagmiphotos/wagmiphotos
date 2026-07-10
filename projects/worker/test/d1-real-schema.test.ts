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
