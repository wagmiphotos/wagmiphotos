import { it, expect } from "vitest";
import { handleGenerate, handleKeygen } from "../src/handler";
import { fakeServices } from "./fakes";
import { sha256Hex } from "../src/auth";
import type { AssetRow } from "../src/types";
import { encryptSecret } from "../src/crypto";
import type { ByokCfg } from "../src/byok";

const BASE = "https://cdn.example.com";
const cfg = { floorSimMax: 0.35, floorSimMin: 0.18, imagePrice: 0.055, now: () => 1000, assetBaseUrl: BASE };

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "a1", prompt: "p", source: "pd12m", source_id: "7",
    model_used: "clip-vit-l-14", width: 10, height: 20,
    mime: "image/webp", source_url: "https://ext/x.jpg", locally_cached: 1, ...over };
}

it("rejects n != 1 with 422", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "x", n: 2 }, s, cfg);
  expect(res.status).toBe(422);
});

it("prompt validation: missing, non-string, blank, and over-long prompts -> 422", async () => {
  const s = fakeServices();
  for (const body of [{}, { prompt: 42 }, { prompt: null }, { prompt: "" }, { prompt: "   " }, { prompt: "a".repeat(2001) }]) {
    const res = await handleGenerate(body as any, s, cfg);
    expect(res.status).toBe(422);
    const j: any = await res.json();
    expect(typeof j.error).toBe("string");
  }
  expect((s as any)._recorded).toHaveLength(0); // rejected before any side effect
});

it("prompt validation: exactly 2000 chars is accepted", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "a".repeat(2000) }, s, cfg);
  expect(res.status).toBe(202); // empty pool, but past validation
});

it("cache_tolerance validation: non-number, NaN, and out-of-range -> 422", async () => {
  const s = fakeServices();
  for (const tol of ["0.5", NaN, Infinity, -0.1, 1.1, {}]) {
    const res = await handleGenerate({ prompt: "x", cache_tolerance: tol } as any, s, cfg);
    expect(res.status).toBe(422);
    const j: any = await res.json();
    expect(typeof j.error).toBe("string");
  }
});

it("cache_tolerance validation: boundary values 0 and 1 are accepted", async () => {
  const s = fakeServices();
  expect((await handleGenerate({ prompt: "x", cache_tolerance: 0 }, s, cfg)).status).toBe(202);
  expect((await handleGenerate({ prompt: "x", cache_tolerance: 1 }, s, cfg)).status).toBe(202);
});

it("hit: score >= floor, cached -> result hit + cost saved", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.data[0].url).toBe(`${BASE}/assets/a1/image.webp`);
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.cost_saved_usd).toBe(0.055);
  expect(j.shared_cache.sizes).toEqual({
    thumb: `${BASE}/assets/a1/thumb.webp`, medium: `${BASE}/assets/a1/medium.webp`, large: `${BASE}/assets/a1/image.webp`,
  });
  expect(j.shared_cache.original_url).toBe("https://ext/x.jpg");
  expect(j.shared_cache.model_used).toBe("clip-vit-l-14");
  expect(j.shared_cache.source).toBe("pd12m");
  expect(j.shared_cache.similarity).toBe(0.40);
  const rec = (s as any)._recorded[0];
  expect(rec).toMatchObject({ normalized: "a fox", assetId: "a1", built: true });
});

it("hit-not-rehosted: serves source_url, still result hit", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset({ locally_cached: 0 }));
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
  const j: any = await res.json();
  expect(j.data[0].url).toBe("https://ext/x.jpg");
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.sizes.thumb).toBeNull();
  expect(j.shared_cache.original_url).toBe("https://ext/x.jpg"); // pre-rehost: same as data[0].url
});

it("approximate: score < floor -> result approximate + pending query, nothing saved", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor(0.15)~0.32
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("approximate");
  // a paid generation is still queued: nothing was saved
  expect(j.shared_cache.cost_saved_usd).toBe(0);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: "a1" });
});

it("hit: recordQuery throws -> logging is best-effort, still 200 with asset url", async () => {
  const s = fakeServices({ queries: { recordQuery: async () => { throw new Error("d1 write failed"); } } });
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.data[0].url).toBe(`${BASE}/assets/a1/image.webp`);
  expect(j.shared_cache.result).toBe("hit");
});

it("empty pool -> 202 pending, query logged without asset", async () => {
  const s = fakeServices(); // no matches
  const res = await handleGenerate({ prompt: "nothing here" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("pending");
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: null });
});

it("match found but asset row missing -> 202 pending", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "ghost", score: 0.9 }); // match exists but asset does not
  const res = await handleGenerate({ prompt: "x" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("pending");
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: null });
});

it("rejects non-boolean generate_on_miss with 422", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "x", generate_on_miss: "no" } as any, s, cfg);
  expect(res.status).toBe(422);
});

it("miss: generate_on_miss defaults to true and is reported as generation_queued", async () => {
  const s = fakeServices(); // no matches -> 202
  const res = await handleGenerate({ prompt: "nothing here" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.generation_queued).toBe(true);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, generate: true });
});

it("miss with generate_on_miss=false: recorded but not queued", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "nothing here", generate_on_miss: false }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.generation_queued).toBe(false);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, generate: false });
});

it("miss with generate_on_miss=false but prompt already queued -> generation_queued true", async () => {
  // store reports the merged state: an earlier request already asked for generation
  const s = fakeServices({ queries: { recordQuery: async () => true } });
  const res = await handleGenerate({ prompt: "nothing here", generate_on_miss: false }, s, cfg);
  const j: any = await res.json();
  expect(j.shared_cache.generation_queued).toBe(true);
});

it("approximate includes generation_queued, hit does not", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor -> approximate
  const approx: any = await (await handleGenerate({ prompt: "a fox", generate_on_miss: false }, s, cfg)).json();
  expect(approx.shared_cache.result).toBe("approximate");
  expect(approx.shared_cache.generation_queued).toBe(false);

  (s as any)._matches[0] = { id: "a1", score: 0.40 }; // above floor -> hit
  const hit: any = await (await handleGenerate({ prompt: "a fox" }, s, cfg)).json();
  expect(hit.shared_cache.result).toBe("hit");
  expect(hit.shared_cache.generation_queued).toBeUndefined();
});

it("miss: recordQuery throws -> 202 reports generation_queued false (nothing was queued)", async () => {
  const s = fakeServices({ queries: { recordQuery: async () => { throw new Error("d1 down"); } } });
  const res = await handleGenerate({ prompt: "nothing here", generate_on_miss: true }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.generation_queued).toBe(false); // demand write failed: not queued
});

it("approximate: recordQuery throws -> generation_queued false (nothing was queued)", async () => {
  const s = fakeServices({ queries: { recordQuery: async () => { throw new Error("d1 down"); } } });
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor -> approximate
  const res = await handleGenerate({ prompt: "a fox", generate_on_miss: true }, s, cfg);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("approximate");
  expect(j.shared_cache.generation_queued).toBe(false);
});

it("orphan tolerance: queries topK 3 and serves the first match with a live asset row", async () => {
  let topKSeen = 0;
  const s = fakeServices();
  const matches = [
    { id: "ghost", score: 0.90 },  // orphan: vector exists, D1 row does not
    { id: "a1", score: 0.40 },     // live asset, above floor
    { id: "a2", score: 0.39 },
  ];
  (s as any).vectorize = { query: async (_v: number[], topK: number) => { topKSeen = topK; return matches; } };
  (s as any)._assets.set("a1", asset());
  (s as any)._assets.set("a2", asset({ id: "a2" }));
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
  expect(topKSeen).toBe(3);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.data[0].url).toBe(`${BASE}/assets/a1/image.webp`); // a1, not the orphan and not a2
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.similarity).toBe(0.40); // score of the served match, not the orphan's
});

it("orphan tolerance: all matches orphaned -> 202 pending", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "ghost1", score: 0.9 }, { id: "ghost2", score: 0.8 });
  const res = await handleGenerate({ prompt: "x" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("pending");
});

it("keygen mints and stores a hashed key owned by the caller", async () => {
  const s = fakeServices();
  const res = await handleKeygen(new Request("https://x", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), s, () => "sc-fixed", "usr_1");
  const j: any = await res.json();
  expect(j.key).toBe("sc-fixed");
  expect((s as any)._keyOwners.size).toBe(1);
  expect((s as any)._keyOwners.get(await sha256Hex("sc-fixed"))).toBe("usr_1");
});

it("keygen rate-limits under a namespaced key (keygen:ip:<ip>)", async () => {
  const seen: string[] = [];
  const s = fakeServices({ rateLimiter: { limit: async (k: string) => { seen.push(k); return true; } } });
  await handleKeygen(new Request("https://x", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), s, () => "sc-fixed", "usr_1");
  expect(seen).toEqual(["keygen:ip:1.2.3.4"]);
});

it("keygen 429 when rate limited", async () => {
  const s = fakeServices({ rateLimiter: { limit: async () => false } });
  const res = await handleKeygen(new Request("https://x"), s, () => "sc-fixed", "usr_1");
  expect(res.status).toBe(429);
});

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const cleanModeration = (async () =>
  new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 })
) as unknown as typeof fetch;

async function byokCtx(s: any, over: Partial<ByokCfg> = {}) {
  await s.byok.put({
    userId: "u1", provider: "openai",
    keyCiphertext: await encryptSecret("sk-user", KEK), keyLast4: "user", monthlyCap: 50, enabled: true,
  });
  return {
    userId: "u1",
    cfg: {
      kek: KEK, moderationKey: "sk-op", bucket: { put: async () => ({}) },
      publicUrlBase: "https://byok.example", now: () => 1783468800, // 2026-07-08 UTC

      fetchFn: cleanModeration,
      providerFor: () => ({ generate: async () => ({ bytes: new Uint8Array([1]).buffer, mime: "image/png" }), validateKey: async () => true }),
      uuid: () => "gen-1",
      ...over,
    } as ByokCfg,
  };
}

it("below-floor + BYOK: returns result=generated with usage block and records built", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below this file's floor (~0.32)
  (s as any)._assets.set("a1", { id: "a1", prompt: "old", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, await byokCtx(s));
  const body: any = await res.json();
  expect(res.status).toBe(200);
  expect(body.shared_cache.result).toBe("generated");
  expect(body.shared_cache.source).toBe("byok");
  expect(body.shared_cache.byok).toEqual({ used: 1, cap: 50, est_spend_usd: 0.055 });
  expect(body.data[0].url).toBe("https://byok.example/byok/gen-1/original.png");
  const recorded = (s as any)._recorded;
  expect(recorded[recorded.length - 1]).toMatchObject({ assetId: "gen-1", built: true });
});

it("empty pool + BYOK: generates instead of 202 pending", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, await byokCtx(s));
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).shared_cache.result).toBe("generated");
});

it("hit is untouched by BYOK", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.99 });
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, await byokCtx(s));
  expect(((await res.json()) as any).shared_cache.result).toBe("hit");
});

it("generate_on_miss=false is the kill switch: no BYOK, normal approximate", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below this file's floor (~0.32)
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const res = await handleGenerate({ prompt: "a red fox", generate_on_miss: false }, s, cfg, await byokCtx(s));
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.byok).toBeUndefined();
});

it("content policy -> 400 with category", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "pikachu portrait" }, s, cfg, await byokCtx(s));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "content_policy", category: "denylist:pikachu" });
});

it("cap reached -> approximate fallback with byok status", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below this file's floor (~0.32)
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const ctx = await byokCtx(s);
  await s.byok.patch("u1", { monthlyCap: 1 });
  await s.byok.reserve("u1", "2026-07", 1);
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, ctx);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.byok).toEqual({ status: "cap_reached" });
});

it("provider failure on empty pool -> 202 pending with byok status", async () => {
  const s = fakeServices();
  const ctx = await byokCtx(s, { providerFor: () => ({ generate: async () => { throw new Error("boom"); }, validateKey: async () => true }) });
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, ctx);
  expect(res.status).toBe(202);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("pending");
  expect(body.shared_cache.byok).toEqual({ status: "provider_error" });
});

it("unexpected byok throw (e.g. transient D1 error) never 500s -> degrades to approximate", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below this file's floor (~0.32)
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const ctx = await byokCtx(s);
  s.byok.get = async () => { throw new Error("d1 down"); };
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, ctx);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.byok).toEqual({ status: "provider_error" });
});

function withCollection(s: any, id = "col_abc", owner = "usr_owner", theme = "watercolor style") {
  s._collectionRows.set(id, { id, owner_user_id: owner, name: "n", theme_prompt: theme, created_at: "x", updated_at: "x" });
  return id;
}

it("scoped: 404 unknown collection", async () => {
  const s: any = fakeServices();
  const res = await handleGenerate({ prompt: "a cat", collection: "col_nope" }, s, cfg);
  expect(res.status).toBe(404);
});

it("scoped: 422 when combined prompt exceeds MAX_PROMPT_LEN", async () => {
  const s: any = fakeServices();
  const id = withCollection(s, "col_abc", "usr_owner", "t".repeat(400));
  const res = await handleGenerate({ prompt: "p".repeat(1700), collection: id }, s, cfg);
  expect(res.status).toBe(422);
});

it("scoped: embeds the combined prompt and queries only the namespace", async () => {
  const s: any = fakeServices();
  const embedCalls: string[] = [];
  s.embedder.textEmbed = async (p: string) => { embedCalls.push(p); return [0.1]; };
  let namespaceQueried: string | null = null;
  s.vectorize.queryNamespace = async (_v: any, ns: string) => { namespaceQueried = ns; return []; };
  s.vectorize.query = async () => { throw new Error("global index must not be queried for scoped requests"); };
  const id = withCollection(s);
  await handleGenerate({ prompt: "a cat", collection: id, generate_on_miss: false }, s, cfg);
  expect(embedCalls).toEqual(["a cat, watercolor style"]);
  expect(namespaceQueried).toBe(id);
});

it("scoped hit: serves the collection asset, echoes collection, bumps serve_count, never records demand", async () => {
  const s: any = fakeServices();
  const id = withCollection(s);
  s._assets.set("a1", { id: "a1", prompt: "a cat, watercolor style", source: "byok", source_id: null, model_used: "gpt-image-1", width: 1024, height: 1024, mime: "image/png", source_url: "https://x/a1.png", locally_cached: 0 });
  s._nsMatches.push({ id: "a1", score: 0.95, ns: id });
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("hit");
  expect(body.shared_cache.collection).toBe(id);
  expect(s._serveCounts.get("a1")).toBe(1);
  expect(s._recorded).toEqual([]); // backfill exclusion: no queries write, ever
});

it("scoped approximate (non-owner): closest match served, no generation, no demand row, serve_count bumped", async () => {
  const s: any = fakeServices();
  const id = withCollection(s, "col_abc", "usr_owner");
  s._assets.set("a1", { id: "a1", prompt: "a dog, watercolor style", source: "byok", source_id: null, model_used: "gpt-image-1", width: 1024, height: 1024, mime: "image/png", source_url: "https://x/a1.png", locally_cached: 0 });
  s._nsMatches.push({ id: "a1", score: 0.2, ns: id }); // below the ≈0.325 floor -> approximate
  await s.byok.put({ userId: "usr_caller", provider: "openai", keyCiphertext: "ct", keyLast4: "1234", monthlyCap: 50, enabled: true }); // caller has their OWN byok
  const byokCtx = { userId: "usr_caller", cfg: { kek: "k", bucket: { put: async () => {} }, publicUrlBase: "https://pub", now: () => 123 } };
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg, byokCtx as any);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.generation_queued).toBe(false);
  expect(body.shared_cache.byok).toBeUndefined(); // non-owner: byok never consulted
  expect(s._generatedInserts).toEqual([]);        // caller's own key must NOT generate into someone else's collection
  expect(s._recorded).toEqual([]);
  expect(s._serveCounts.get("a1")).toBe(1);
});

it("scoped empty pool (non-owner or no byok): 202 pending, generation_queued false, no demand row", async () => {
  const s: any = fakeServices();
  const id = withCollection(s);
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg);
  expect(res.status).toBe(202);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("pending");
  expect(body.shared_cache.generation_queued).toBe(false);
  expect(body.shared_cache.collection).toBe(id);
  expect(s._recorded).toEqual([]);
});

it("global path: hit bumps serve_count; generated does not", async () => {
  const s: any = fakeServices();
  s._assets.set("g1", { id: "g1", prompt: "p", source: "pd12m", source_id: null, model_used: "m", width: 1, height: 1, mime: "image/jpeg", source_url: "https://x/g1.jpg", locally_cached: 0 });
  s._matches.push({ id: "g1", score: 0.99 });
  await handleGenerate({ prompt: "p" }, s, cfg);
  expect(s._serveCounts.get("g1")).toBe(1);
});

it("global path unchanged: misses still record demand", async () => {
  const s: any = fakeServices();
  const res = await handleGenerate({ prompt: "novel prompt" }, s, cfg);
  expect(res.status).toBe(202);
  expect(s._recorded.length).toBe(1);
  expect(s._recorded[0].generate).toBe(true);
});

it("scoped: 422 on non-string collection", async () => {
  const s: any = fakeServices();
  const res = await handleGenerate({ prompt: "p", collection: 7 as any }, s, cfg);
  expect(res.status).toBe(422);
});

it("scoped owner + working BYOK: generates on miss, echoes collection, no demand row, no serve bump", async () => {
  const s: any = fakeServices();
  const id = withCollection(s, "col_abc", "u1"); // owner IS the BYOK caller (byokCtx seeds u1)
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg, await byokCtx(s));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("generated");
  expect(body.shared_cache.collection).toBe(id);
  expect(body.shared_cache.byok).toEqual({ used: 1, cap: 50, est_spend_usd: 0.055 });
  expect(s._generatedInserts[0].collectionId).toBe(id);
  expect(s._nsUpserted).toEqual([{ id: "gen-1", vector: [0.1, 0.2, 0.3], namespace: id }]);
  expect(s._recorded).toEqual([]);     // scoped: no demand row, even for the generated return
  expect(s._serveCounts.size).toBe(0); // generated must not bump serve_count
});

it("scoped owner, cap reached: pending fallback carries byok status, collection echo, generation_queued false, no demand row", async () => {
  const s: any = fakeServices();
  const id = withCollection(s, "col_abc", "u1");
  const ctx = await byokCtx(s);
  await s.byok.patch("u1", { monthlyCap: 1 });
  await s.byok.reserve("u1", "2026-07", 1); // spend the month (byokCtx now => 2026-07-08)
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg, ctx);
  expect(res.status).toBe(202); // empty namespace pool -> pending
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("pending");
  expect(body.shared_cache.byok).toEqual({ status: "cap_reached" });
  expect(body.shared_cache.generation_queued).toBe(false);
  expect(body.shared_cache.collection).toBe(id);
  expect(s._generatedInserts).toEqual([]);
  expect(s._recorded).toEqual([]);
});
