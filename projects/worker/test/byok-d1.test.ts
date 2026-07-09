import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";

function fakeDb(firstResult: any = null, allResults: any[] = []) {
  const calls: { sql: string; args: any[] }[] = [];
  const db: any = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as any[],
        bind(...args: any[]) { this._args = args; return this; },
        async first() { calls.push({ sql, args: this._args }); return firstResult; },
        async run() { calls.push({ sql, args: this._args }); return { success: true }; },
        async all() { calls.push({ sql, args: this._args }); return { results: allResults }; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

it("put upserts by user and clears last_error", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.put({ userId: "u1", provider: "openai", keyCiphertext: "ct", keyLast4: "ab12", monthlyCap: 50, enabled: true });
  expect(calls[0].sql).toContain("INSERT INTO byok_keys");
  expect(calls[0].sql).toContain("ON CONFLICT(user_id)");
  expect(calls[0].sql).toContain("last_error = NULL");
  expect(calls[0].args).toEqual(["u1", "openai", "ct", "ab12", 1, 50]);
});

it("reserve upserts the month row then increments only under the cap", async () => {
  const { db, calls } = fakeDb({ count: 1 });
  const { byok } = makeD1Stores(db);
  const ok = await byok.reserve("u1", "2026-07", 50);
  expect(ok).toBe(true);
  expect(calls[0].sql).toContain("INSERT OR IGNORE INTO byok_usage");
  expect(calls[1].sql).toContain("count = count + 1");
  expect(calls[1].sql).toContain("count < ?");
  expect(calls[1].sql).toContain("RETURNING count");
  expect(calls[1].args).toEqual(["u1", "2026-07", 50]);
});

it("reserve returns false when the guarded update matches no row (cap spent)", async () => {
  const { db } = fakeDb(null);
  const { byok } = makeD1Stores(db);
  expect(await byok.reserve("u1", "2026-07", 50)).toBe(false);
});

it("refund decrements but never below zero", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.refund("u1", "2026-07");
  expect(calls[0].sql).toContain("MAX(count - 1, 0)");
});

it("disable flips enabled off and records the error", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.disable("u1", "provider_auth_failed");
  expect(calls[0].sql).toContain("enabled = 0");
  expect(calls[0].args).toEqual(["provider_auth_failed", "u1"]);
});

it("getUsage defaults to zeros when no row", async () => {
  const { db } = fakeDb(null);
  const { byok } = makeD1Stores(db);
  expect(await byok.getUsage("u1", "2026-07")).toEqual({ count: 0, est_spend_usd: 0 });
});

it("patch updates only the provided fields", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.patch("u1", { monthlyCap: 100 });
  expect(calls[0].sql).toContain("monthly_cap = ?");
  expect(calls[0].sql).not.toContain("enabled = ?");
});

it("insertGenerated writes a byok asset row satisfying legacy NOT NULLs", async () => {
  const { db, calls } = fakeDb();
  const { assets } = makeD1Stores(db);
  await assets.insertGenerated({
    id: "gen-1", prompt: "a red fox", sourceUrl: "https://byok.example/byok/gen-1/original.png",
    mime: "image/png", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai", priceUsd: 0.04,
    createdBy: "usr_abc",
  });
  expect(calls[0].sql).toContain("INSERT INTO assets");
  expect(calls[0].sql).toContain("'byok'");
  expect(calls[0].sql).toContain("created_by");
  // legacy url column mirrors source_url until the rehost pipeline derives sizes
  expect(calls[0].args).toEqual(["gen-1", "a red fox", "gpt-image-1", 1024, 1024, "image/png",
    "https://byok.example/byok/gen-1/original.png", "https://byok.example/byok/gen-1/original.png", 0.04, "openai",
    "usr_abc"]);
});

// created_by is an operator-facing audit column: no public read path may select
// it, or user ids would leak into library/generation responses.
it("asset read paths never select created_by", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.getAsset("a1");
  await assets.searchAssets({ q: "fox", limit: 10, offset: 0 });
  await assets.getAssetsByIds(["a1"]);
  for (const c of calls) expect(c.sql).not.toContain("created_by");
});
