import { it, expect } from "vitest";
import { handleLibrarySearch, handleLibraryDownload, assetFilename } from "../src/library";
import { fakeServices } from "./fakes";
import type { LibraryAssetRow } from "../src/types";

const BASE = "https://cdn.example.com";
const cfg = { floorSimMin: 0.72, assetBaseUrl: BASE };

function libRow(over: Partial<LibraryAssetRow> = {}): LibraryAssetRow {
  return { id: "a1", prompt: "a fox", source: "pd12m", source_id: null,
    model_used: "flux", width: 10, height: 20,
    mime: "image/webp", source_url: null, locally_cached: 1, created_at: "2026-07-03 00:00:00", ...over };
}

it("search: defaults q='' limit 24 offset 0, fetches limit+1", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow());
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.images).toHaveLength(1);
  expect(j.has_more).toBe(false);
  expect((s as any)._searchCalls[0]).toEqual({ q: "", limit: 25, offset: 0 });
});

it("search: response projects to documented public shape, omits internal columns", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow());
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg);
  const j: any = await res.json();
  const img = j.images[0];
  expect(img).not.toHaveProperty("source_id");
  expect(img).not.toHaveProperty("source_url");
  expect(img).not.toHaveProperty("locally_cached");
  expect(img).toEqual({
    id: "a1", prompt: "a fox", thumb_url: `${BASE}/assets/a1/thumb.webp`, medium_url: `${BASE}/assets/a1/medium.webp`,
    url: `${BASE}/assets/a1/image.webp`, width: 10, height: 20, mime: "image/webp",
    model_used: "flux", source: "pd12m", created_at: "2026-07-03 00:00:00", original_url: null,
  });
});

it("search: sourced rows expose original_url", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow({ source_url: "https://pd12m.example/x.jpg" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg);
  const j: any = await res.json();
  expect(j.images[0].original_url).toBe("https://pd12m.example/x.jpg");
  expect(j.images[0]).not.toHaveProperty("source_url");
});

it("search: has_more true when a full extra row exists, images trimmed to limit", async () => {
  const s = fakeServices();
  for (let i = 0; i < 25; i++) (s as any)._libraryRows.push(libRow({ id: "a" + i }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg);
  const j: any = await res.json();
  expect(j.images).toHaveLength(24);
  expect(j.has_more).toBe(true);
});

it("search: passes q and offset through, clamps numeric limit to 1..60", async () => {
  // non-empty q now goes through the semantic path first; force the fallback
  // so this still exercises the LIKE call's limit/offset math.
  const s = fakeServices({ embedder: { textEmbed: async () => { throw new Error("offline"); } } });
  await handleLibrarySearch(new URL("https://x/v1/library?q=fox&limit=999&offset=48"), s, cfg);
  expect((s as any)._searchCalls[0]).toEqual({ q: "fox", limit: 61, offset: 48 });
  await handleLibrarySearch(new URL("https://x/v1/library?limit=0"), s, cfg);
  expect((s as any)._searchCalls[1]).toEqual({ q: "", limit: 2, offset: 0 });
});

it("search: q over 200 chars -> 400, q at the cap still searches", async () => {
  // force the LIKE fallback (see note above) so the at-cap case still reaches searchAssets.
  const s = fakeServices({ embedder: { textEmbed: async () => { throw new Error("offline"); } } });
  const tooLong = await handleLibrarySearch(new URL("https://x/v1/library?q=" + "a".repeat(201)), s, cfg);
  expect(tooLong.status).toBe(400);
  expect(typeof (await tooLong.json() as any).error).toBe("string");
  expect((s as any)._searchCalls).toHaveLength(0);
  const atCap = await handleLibrarySearch(new URL("https://x/v1/library?q=" + "a".repeat(200)), s, cfg);
  expect(atCap.status).toBe(200);
  expect((s as any)._searchCalls[0].q).toHaveLength(200);
});

it("search: non-numeric or fractional limit/offset and negative offset -> 400", async () => {
  const s = fakeServices();
  for (const qs of ["limit=abc", "limit=1.5", "offset=-1", "offset=1.5", "offset=xyz"]) {
    const res = await handleLibrarySearch(new URL(`https://x/v1/library?${qs}`), s, cfg);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(typeof j.error).toBe("string");
  }
  expect((s as any)._searchCalls).toHaveLength(0);
});

it("semantic search: embeds q, merges shards, floors at floorSimMin, orders by similarity", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "b", score: 0.95 }, { id: "a", score: 0.80 }, { id: "junk", score: 0.60 });
  (s as any)._assets.set("a", libRow({ id: "a" }));
  (s as any)._assets.set("b", libRow({ id: "b" }));
  (s as any)._assets.set("junk", libRow({ id: "junk" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat"), s, { floorSimMin: 0.72 });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.images.map((i: any) => i.id)).toEqual(["b", "a"]); // junk floored out
});

it("semantic search: offset/limit slice the merged window and set has_more", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "x1", score: 0.9 }, { id: "x2", score: 0.85 }, { id: "x3", score: 0.8 });
  (s as any)._assets.set("x1", libRow({ id: "x1" }));
  (s as any)._assets.set("x2", libRow({ id: "x2" }));
  (s as any)._assets.set("x3", libRow({ id: "x3" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat&limit=1&offset=1"), s, { floorSimMin: 0.72 });
  const body: any = await res.json();
  expect(body.images.map((i: any) => i.id)).toEqual(["x2"]); // the middle match
  expect(body.has_more).toBe(true);
});

it("semantic search: ids missing from D1 are skipped (orphan vectors)", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "has-row", score: 0.9 }, { id: "orphan", score: 0.85 });
  (s as any)._assets.set("has-row", libRow({ id: "has-row" }));
  // "orphan" intentionally has no D1 row
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat"), s, { floorSimMin: 0.72 });
  const body: any = await res.json();
  expect(body.images.map((i: any) => i.id)).toEqual(["has-row"]);
});

it("falls back to LIKE search when the embedder throws", async () => {
  const s = fakeServices({ embedder: { textEmbed: async () => { throw new Error("no AI binding"); } } });
  (s as any)._libraryRows.push(libRow({ id: "like-hit" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat"), s, { floorSimMin: 0.72 });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect((s as any)._searchCalls[0]).toEqual({ q: "cat", limit: 25, offset: 0 });
  expect(body.images.map((i: any) => i.id)).toEqual(["like-hit"]);
});

it("falls back to LIKE search when vectorize.query throws", async () => {
  const s = fakeServices({ vectorize: { query: async () => { throw new Error("index unavailable"); }, upsert: async () => {}, queryNamespace: async () => [], upsertNamespace: async () => {}, deleteByIds: async () => {} } });
  (s as any)._libraryRows.push(libRow({ id: "like-hit" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat"), s, { floorSimMin: 0.72 });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect((s as any)._searchCalls[0]).toEqual({ q: "cat", limit: 25, offset: 0 });
  expect(body.images.map((i: any) => i.id)).toEqual(["like-hit"]);
});

it("falls back to LIKE search when getAssetsByIds throws (embedder+vectorize succeed)", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "b", score: 0.95 }); // above floor, so hydration is reached
  s.assets.getAssetsByIds = async () => { throw new Error("D1 blip"); };
  (s as any)._libraryRows.push(libRow({ id: "like-hit" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library?q=cat"), s, { floorSimMin: 0.72 });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect((s as any)._searchCalls[0]).toEqual({ q: "cat", limit: 25, offset: 0 });
  expect(body.images.map((i: any) => i.id)).toEqual(["like-hit"]);
});

it("empty q keeps the recency browse (vectorize and embedder never called)", async () => {
  let vectorizeCalled = false;
  let embedderCalled = false;
  const s = fakeServices({
    vectorize: { query: async () => { vectorizeCalled = true; return []; }, upsert: async () => {}, queryNamespace: async () => [], upsertNamespace: async () => {}, deleteByIds: async () => {} },
    embedder: { textEmbed: async () => { embedderCalled = true; return [0, 0, 0]; } },
  });
  (s as any)._libraryRows.push(libRow());
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s, { floorSimMin: 0.72 });
  expect(res.status).toBe(200);
  expect(vectorizeCalled).toBe(false);
  expect(embedderCalled).toBe(false);
});

function okUpstream(contentType: string | null = "image/webp"): (url: string) => Promise<Response> {
  return async () => {
    const res = new Response("BYTES", { status: 200, headers: contentType ? { "content-type": contentType } : {} });
    if (!contentType) res.headers.delete("content-type");
    return res;
  };
}

it("download: unknown id -> 404", async () => {
  const s = fakeServices();
  const res = await handleLibraryDownload("nope", s, cfg, okUpstream());
  expect(res.status).toBe(404);
});

it("download: streams upstream with attachment filename from prompt slug", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow({ prompt: "A Fox! Jumping Over 2 Logs" }));
  let fetched = "";
  const res = await handleLibraryDownload("a1", s, cfg, async (u) => { fetched = u; return okUpstream()(u); });
  expect(res.status).toBe(200);
  expect(fetched).toBe(`${BASE}/assets/a1/image.webp`);
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="a-fox-jumping-over-2-logs.webp"');
  expect(await res.text()).toBe("BYTES");
});

it("download: not locally cached fetches source_url", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow({ locally_cached: 0, source_url: "https://o.example/p.png" }));
  let fetched = "";
  const res = await handleLibraryDownload("a1", s, cfg, async (u) => { fetched = u; return okUpstream()(u); });
  expect(res.status).toBe(200);
  expect(fetched).toBe("https://o.example/p.png");
});

it("download: upstream non-OK or thrown fetch -> 502", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow());
  const bad = await handleLibraryDownload("a1", s, cfg, async () => new Response("nope", { status: 403 }));
  expect(bad.status).toBe(502);
  const threw = await handleLibraryDownload("a1", s, cfg, async () => { throw new Error("net"); });
  expect(threw.status).toBe(502);
});

it("download: content type falls back to asset mime, then octet-stream", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow({ mime: "image/png" }));
  const res = await handleLibraryDownload("a1", s, cfg, okUpstream(null));
  expect(res.headers.get("content-type")).toBe("image/png");
  (s as any)._assets.set("a2", libRow({ id: "a2", mime: null }));
  const res2 = await handleLibraryDownload("a2", s, cfg, okUpstream(null));
  expect(res2.headers.get("content-type")).toBe("application/octet-stream");
});

it("assetFilename: slugs, truncates to 60 chars, falls back to id, maps mime to ext", () => {
  expect(assetFilename({ id: "x", prompt: "Neon:  City!!", mime: null }, "image/jpeg")).toBe("neon-city.jpg");
  expect(assetFilename({ id: "x", prompt: "???", mime: null }, null)).toBe("x.bin");
  const long = "a".repeat(80);
  expect(assetFilename({ id: "x", prompt: long, mime: "image/gif" }, null)).toBe("a".repeat(60) + ".gif");
  expect(assetFilename({ id: "x", prompt: "p", mime: "image/webp; charset=binary" }, null)).toBe("p.webp");
});
