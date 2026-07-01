import { it, expect } from "vitest";
import { handleGenerate, handleKeygen } from "../src/handler";
import { fakeServices } from "./fakes";
import { sha256Hex } from "../src/auth";
import type { AssetRow } from "../src/types";

const cfg = { floorSimMax: 0.35, floorSimMin: 0.18, imagePrice: 0.04, now: () => 1000 };

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "a1", prompt: "p", source: "pd12m", source_id: "7", thumb_url: "T", medium_url: "M",
    url: "https://cdn/large.webp", model_used: "clip-vit-l-14", width: 10, height: 20,
    mime: "image/webp", source_url: "https://ext/x.jpg", locally_cached: 1, ...over };
}

it("rejects n != 1 with 422", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "x", n: 2 }, s, cfg);
  expect(res.status).toBe(422);
});

it("hit: score >= floor, cached -> result hit + cost saved", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.data[0].url).toBe("https://cdn/large.webp");
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.cost_saved_usd).toBe(0.04);
  expect(j.shared_cache.sizes).toEqual({ thumb: "T", medium: "M", large: "https://cdn/large.webp" });
  expect(j.shared_cache.model_used).toBe("clip-vit-l-14");
  expect(j.shared_cache.source).toBe("pd12m");
  expect(j.shared_cache.similarity).toBe(0.40);
  const rec = (s as any)._recorded[0];
  expect(rec).toMatchObject({ normalized: "a fox", assetId: "a1", built: true });
});

it("hit-not-rehosted: serves source_url, still result hit", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset({ locally_cached: 0, url: "https://ext/x.jpg", thumb_url: null, medium_url: null }));
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
  const j: any = await res.json();
  expect(j.data[0].url).toBe("https://ext/x.jpg");
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.sizes.thumb).toBeNull();
});

it("approximate: score < floor -> result approximate + pending query", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor(0.15)~0.32
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("approximate");
  expect(j.shared_cache.cost_saved_usd).toBe(0.04);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: "a1" });
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

it("keygen mints and stores a hashed key", async () => {
  const s = fakeServices();
  const res = await handleKeygen(new Request("https://x", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), s, () => "sc-fixed");
  const j: any = await res.json();
  expect(j.key).toBe("sc-fixed");
  expect((s as any)._keyHashes.size).toBe(1);
  expect((s as any)._keyHashes.has(await sha256Hex("sc-fixed"))).toBe(true);
});

it("keygen 429 when rate limited", async () => {
  const s = fakeServices({ rateLimiter: { limit: async () => false } });
  const res = await handleKeygen(new Request("https://x"), s, () => "sc-fixed");
  expect(res.status).toBe(429);
});
