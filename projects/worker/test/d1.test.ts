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

it("getAsset selects by id and maps row", async () => {
  const row = { id: "a1", prompt: "p", source: "pd12m", source_id: "7", thumb_url: null,
    medium_url: null, url: "https://ext/x.jpg", model_used: "clip-vit-l-14", width: 10, height: 20,
    mime: "image/jpeg", source_url: "https://ext/x.jpg", locally_cached: 0 };
  const { db, calls } = fakeDb(row);
  const { assets } = makeD1Stores(db);
  const got = await assets.getAsset("a1");
  expect(got?.id).toBe("a1");
  expect(calls[0].sql).toContain("FROM assets");
  expect(calls[0].args).toEqual(["a1"]);
});

it("getAsset returns null when missing", async () => {
  const { db } = fakeDb(null);
  const { assets } = makeD1Stores(db);
  expect(await assets.getAsset("nope")).toBeNull();
});

it("recordQuery upserts with count increment and forward-only built", async () => {
  const { db, calls } = fakeDb();
  const { queries } = makeD1Stores(db);
  await queries.recordQuery({ normalized: "a fox", original: "A Fox", assetId: "a1", similarity: 0.3, built: true, generate: true });
  expect(calls[0].sql).toContain("INSERT INTO queries");
  expect(calls[0].sql).toContain("ON CONFLICT");
  expect(calls[0].sql).toContain("count = queries.count + 1");
  // status param is 'built' when built=true, else 'pending'
  expect(calls[0].args).toContain("built");
  expect(calls[0].args).toContain("a fox");
  // assert the forward-only clause: built rows never revert to pending
  expect(calls[0].sql).toContain("CASE WHEN queries.status = 'built' THEN 'built' ELSE excluded.status END");
});

it("recordQuery merges generate forward-only: generation wins over opt-out", async () => {
  // DB row already wants generation; a generate_on_miss=false request must not downgrade it
  const { db, calls } = fakeDb({ generate: 1 });
  const { queries } = makeD1Stores(db);
  const effective = await queries.recordQuery({
    normalized: "a fox", original: "A Fox", assetId: null, similarity: 0, built: false, generate: false,
  });
  expect(calls[0].sql).toContain("generate = MAX(queries.generate, excluded.generate)");
  expect(calls[0].sql).toContain("RETURNING generate");
  expect(calls[0].args).toContain(0); // request's opt-out bound as 0
  expect(effective).toBe(true); // merged state: still queued for generation
});

it("recordQuery returns effective generate=false when row stays opted out", async () => {
  const { db } = fakeDb({ generate: 0 });
  const { queries } = makeD1Stores(db);
  const effective = await queries.recordQuery({
    normalized: "a fox", original: "A Fox", assetId: null, similarity: 0, built: false, generate: false,
  });
  expect(effective).toBe(false);
});

it("verifyKey and addKey hit api_keys", async () => {
  const { db, calls } = fakeDb({ 1: 1 });
  const { keys } = makeD1Stores(db);
  expect(await keys.verifyKey("hashX")).toBe(true);
  expect(calls[0].sql).toContain("FROM api_keys");
  expect(calls[0].args).toEqual(["hashX"]);
  await keys.addKey("hashY");
  expect(calls[1].sql).toContain("INSERT");
  expect(calls[1].sql).toContain("api_keys");
  expect(calls[1].args).toEqual(["hashY"]);
});

it("searchAssets browse mode: no WHERE, ordered newest-first, binds limit/offset", async () => {
  const row = { id: "a1", prompt: "p", source: "pd12m", source_id: null, thumb_url: null,
    medium_url: null, url: "u", model_used: null, width: null, height: null,
    mime: null, source_url: null, locally_cached: 0, created_at: "2026-07-03 00:00:00" };
  const { db, calls } = fakeDb(null, [row]);
  const { assets } = makeD1Stores(db);
  const got = await assets.searchAssets({ q: "", limit: 25, offset: 0 });
  expect(got).toEqual([row]);
  expect(calls[0].sql).not.toContain("WHERE");
  expect(calls[0].sql).toContain("ORDER BY created_at DESC, id DESC");
  expect(calls[0].sql).toContain("created_at");
  expect(calls[0].args).toEqual([25, 0]);
});

it("searchAssets query mode: LIKE over prompt with bound pattern", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "fox", limit: 10, offset: 20 });
  expect(calls[0].sql).toContain("WHERE prompt LIKE ? ESCAPE '\\'");
  expect(calls[0].args).toEqual(["%fox%", 10, 20]);
});

it("searchAssets escapes LIKE wildcards in user input", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "100%_\\", limit: 5, offset: 0 });
  expect(calls[0].args[0]).toBe("%100\\%\\_\\\\%");
});

it("searchAssets tolerates missing results array", async () => {
  const { db } = fakeDb(null, undefined as any);
  const { assets } = makeD1Stores(db);
  expect(await assets.searchAssets({ q: "", limit: 5, offset: 0 })).toEqual([]);
});
