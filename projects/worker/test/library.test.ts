import { it, expect } from "vitest";
import { handleLibrarySearch } from "../src/library";
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
