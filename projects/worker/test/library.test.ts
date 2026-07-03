import { it, expect } from "vitest";
import { handleLibrarySearch, handleLibraryDownload, assetFilename } from "../src/library";
import { fakeServices } from "./fakes";
import type { LibraryAssetRow } from "../src/types";

function libRow(over: Partial<LibraryAssetRow> = {}): LibraryAssetRow {
  return { id: "a1", prompt: "a fox", source: "pd12m", source_id: null, thumb_url: "T",
    medium_url: "M", url: "https://cdn/large.webp", model_used: "flux", width: 10, height: 20,
    mime: "image/webp", source_url: null, locally_cached: 1, created_at: "2026-07-03 00:00:00", ...over };
}

it("search: defaults q='' limit 24 offset 0, fetches limit+1", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow());
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.images).toHaveLength(1);
  expect(j.has_more).toBe(false);
  expect((s as any)._searchCalls[0]).toEqual({ q: "", limit: 25, offset: 0 });
});

it("search: has_more true when a full extra row exists, images trimmed to limit", async () => {
  const s = fakeServices();
  for (let i = 0; i < 25; i++) (s as any)._libraryRows.push(libRow({ id: "a" + i }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s);
  const j: any = await res.json();
  expect(j.images).toHaveLength(24);
  expect(j.has_more).toBe(true);
});

it("search: passes q and offset through, clamps numeric limit to 1..60", async () => {
  const s = fakeServices();
  await handleLibrarySearch(new URL("https://x/v1/library?q=fox&limit=999&offset=48"), s);
  expect((s as any)._searchCalls[0]).toEqual({ q: "fox", limit: 61, offset: 48 });
  await handleLibrarySearch(new URL("https://x/v1/library?limit=0"), s);
  expect((s as any)._searchCalls[1]).toEqual({ q: "", limit: 2, offset: 0 });
});

it("search: non-numeric limit/offset and negative or fractional offset -> 400", async () => {
  const s = fakeServices();
  for (const qs of ["limit=abc", "offset=-1", "offset=1.5", "offset=xyz"]) {
    const res = await handleLibrarySearch(new URL(`https://x/v1/library?${qs}`), s);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(typeof j.error).toBe("string");
  }
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
  const res = await handleLibraryDownload("nope", s, okUpstream());
  expect(res.status).toBe(404);
});

it("download: streams upstream with attachment filename from prompt slug", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow({ prompt: "A Fox! Jumping Over 2 Logs" }));
  let fetched = "";
  const res = await handleLibraryDownload("a1", s, async (u) => { fetched = u; return okUpstream()(u); });
  expect(res.status).toBe(200);
  expect(fetched).toBe("https://cdn/large.webp");
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="a-fox-jumping-over-2-logs.webp"');
  expect(await res.text()).toBe("BYTES");
});

it("download: upstream non-OK or thrown fetch -> 502", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow());
  const bad = await handleLibraryDownload("a1", s, async () => new Response("nope", { status: 403 }));
  expect(bad.status).toBe(502);
  const threw = await handleLibraryDownload("a1", s, async () => { throw new Error("net"); });
  expect(threw.status).toBe(502);
});

it("download: content type falls back to asset mime, then octet-stream", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", libRow({ mime: "image/png" }));
  const res = await handleLibraryDownload("a1", s, okUpstream(null));
  expect(res.headers.get("content-type")).toBe("image/png");
  (s as any)._assets.set("a2", libRow({ id: "a2", mime: null }));
  const res2 = await handleLibraryDownload("a2", s, okUpstream(null));
  expect(res2.headers.get("content-type")).toBe("application/octet-stream");
});

it("assetFilename: slugs, truncates to 60 chars, falls back to id, maps mime to ext", () => {
  expect(assetFilename({ id: "x", prompt: "Neon:  City!!", mime: null }, "image/jpeg")).toBe("neon-city.jpg");
  expect(assetFilename({ id: "x", prompt: "???", mime: null }, null)).toBe("x.bin");
  const long = "a".repeat(80);
  expect(assetFilename({ id: "x", prompt: long, mime: "image/gif" }, null)).toBe("a".repeat(60) + ".gif");
  expect(assetFilename({ id: "x", prompt: "p", mime: "image/webp; charset=binary" }, null)).toBe("p.webp");
});
