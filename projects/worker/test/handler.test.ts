import { it, expect } from "vitest";
import { handleGenerate, handleKeygen } from "../src/handler";
import { fakeServices } from "./fakes";
import { sha256Hex } from "../src/auth";
import type { AssetRow } from "../src/types";

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

it("cache_tolerance and generate_on_miss are ignored fields: same response as without them, never 422", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  // score 0.20 is below the DEFAULT_CACHE_TOLERANCE floor (~0.3245) but ABOVE
  // the floor a tolerance of 0.9 would produce (~0.197) — if the field were
  // honored this would flip to "hit". It doesn't: tolerance is pinned server-side.
  (s as any)._matches.push({ id: "a1", score: 0.20 });
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.9, generate_on_miss: false } as any, s, cfg);
  expect(res.status).toBe(200); // not 422 — unknown fields are simply ignored
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("approximate");
});

it("hit: score >= floor, cached -> result hit + cost saved", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
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

it("approximate: score < floor -> result approximate with similarity + image url, recordQuery generate: true, nothing saved", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor(~0.3245)
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.shared_cache.result).toBe("approximate");
  expect(j.shared_cache.similarity).toBe(0.20);
  expect(j.data[0].url).toBe(`${BASE}/assets/a1/image.webp`);
  // a paid generation is still queued: nothing was saved
  expect(j.shared_cache.cost_saved_usd).toBe(0);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: "a1", generate: true });
});

it("hit: recordQuery throws -> logging is best-effort, still 200 with asset url", async () => {
  const s = fakeServices({ queries: { recordQuery: async () => { throw new Error("d1 write failed"); } } });
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.data[0].url).toBe(`${BASE}/assets/a1/image.webp`);
  expect(j.shared_cache.result).toBe("hit");
});

it("empty pool -> 202 pending, query logged without asset, generation queued (unscoped)", async () => {
  const s = fakeServices(); // no matches
  const res = await handleGenerate({ prompt: "nothing here" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("pending");
  expect(j.shared_cache.generation_queued).toBe(true);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: null, generate: true });
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

it("approximate includes generation_queued, hit does not", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor -> approximate
  const approx: any = await (await handleGenerate({ prompt: "a fox" }, s, cfg)).json();
  expect(approx.shared_cache.result).toBe("approximate");
  expect(approx.shared_cache.generation_queued).toBe(true);

  (s as any)._matches[0] = { id: "a1", score: 0.40 }; // above floor -> hit
  const hit: any = await (await handleGenerate({ prompt: "a fox" }, s, cfg)).json();
  expect(hit.shared_cache.result).toBe("hit");
  expect(hit.shared_cache.generation_queued).toBeUndefined();
});

it("miss: recordQuery throws -> 202 reports generation_queued false (nothing was queued)", async () => {
  const s = fakeServices({ queries: { recordQuery: async () => { throw new Error("d1 down"); } } });
  const res = await handleGenerate({ prompt: "nothing here" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.generation_queued).toBe(false); // demand write failed: not queued
});

it("approximate: recordQuery throws -> generation_queued false (nothing was queued)", async () => {
  const s = fakeServices({ queries: { recordQuery: async () => { throw new Error("d1 down"); } } });
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor -> approximate
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
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
  await handleGenerate({ prompt: "a cat", collection: id }, s, cfg);
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

it("scoped approximate: best namespace match below floor -> result approximate, generation_queued false, no demand row, serve_count still bumped", async () => {
  const s: any = fakeServices();
  const id = withCollection(s);
  s._assets.set("a1", { id: "a1", prompt: "a cat, watercolor style", source: "byok", source_id: null, model_used: "gpt-image-1", width: 1024, height: 1024, mime: "image/png", source_url: "https://x/a1.png", locally_cached: 0 });
  s._nsMatches.push({ id: "a1", score: 0.20, ns: id }); // below floor(~0.3245)
  const res = await handleGenerate({ prompt: "a cat", collection: id }, s, cfg);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.generation_queued).toBe(false);
  expect(body.shared_cache.collection).toBe(id);
  expect(s._recorded).toEqual([]); // scoped never writes demand, even on a miss
  expect(s._serveCounts.get("a1")).toBe(1); // still served, so still counted
});

it("scoped empty pool -> 202 pending, generation_queued false, no demand row (backfill exclusion)", async () => {
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
