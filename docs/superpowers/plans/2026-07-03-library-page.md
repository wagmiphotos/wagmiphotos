# Library Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `#/library` page on wagmi.photos that keyword-searches the shared image library (D1 `assets` table) and downloads images through a CORS-safe worker proxy.

**Architecture:** Two new public GET endpoints on the existing Cloudflare Worker — `/v1/library` (keyword search over `assets.prompt` via D1 `LIKE`) and `/v1/library/:id/download` (server-side proxy of the asset's full-size URL with a `Content-Disposition: attachment` header). The frontend is a new view in the existing single-file hash-routed SPA (`public/index.html`).

**Tech Stack:** Cloudflare Workers (wrangler 3), D1 (SQLite), TypeScript, vitest, vanilla JS/CSS in `index.html`.

**Spec:** `docs/superpowers/specs/2026-07-03-library-page-design.md`

## Global Constraints

- All work happens in `projects/worker/` (except this plan/spec in `docs/`).
- Run tests from `projects/worker/`: `npm test` (vitest). All tests must pass before each commit.
- New endpoints are public: no API key, no rate limiting.
- Brand copy is `wagmi.photos` (lowercase), never `WagmiPhotos`.
- Search endpoint: `q` optional; `limit` default 24, numeric values clamped to 1–60, non-numeric → 400; `offset` default 0, non-numeric or negative → 400.
- Download filename: prompt slugged (lowercase, non-alphanumerics → dashes, trimmed, max 60 chars, fallback to asset id) + extension from mime (`png`, `jpg`, `webp`, `gif`, default `bin`).
- Frontend styling must reuse the existing black/red design tokens (`var(--ink)`, `var(--red)`, `var(--paper)`, `var(--card)`, `var(--line)`, `var(--muted)`) and existing classes (`page-head`, `eyebrow`, `section-title`, `section-sub`, `input-field`, `btn`) where possible.
- Working branch: `feat/library-page` (already created).

---

### Task 1: D1 `searchAssets` store method

**Files:**
- Modify: `projects/worker/src/types.ts`
- Modify: `projects/worker/src/d1.ts`
- Test: `projects/worker/test/d1.test.ts`

**Interfaces:**
- Consumes: existing `AssetRow`, `AssetStore`, `makeD1Stores(db)` in `src/d1.ts` / `src/types.ts`.
- Produces: `LibraryAssetRow` (= `AssetRow` + `created_at: string`) and
  `AssetStore.searchAssets(i: { q: string; limit: number; offset: number }): Promise<LibraryAssetRow[]>`.
  Empty `q` = browse mode (no WHERE clause). Non-empty `q` = case-insensitive
  `LIKE '%q%' ESCAPE '\'` with `%`, `_`, `\` escaped in the user input. Ordering is
  always `created_at DESC, id DESC`.

- [ ] **Step 1: Extend the fake DB in the test file to support `.all()` results**

In `projects/worker/test/d1.test.ts`, replace the `fakeDb` function (lines 4–19) with:

```ts
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
```

- [ ] **Step 2: Write the failing tests**

Append to `projects/worker/test/d1.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd projects/worker && npm test -- d1.test.ts`
Expected: the four new tests FAIL (TypeScript error / `searchAssets is not a function`); existing tests still pass.

- [ ] **Step 4: Add the types**

In `projects/worker/src/types.ts`, after the `AssetRow` interface (line 6), add:

```ts
export interface LibraryAssetRow extends AssetRow { created_at: string; }
```

Replace the `AssetStore` interface (line 10) with:

```ts
export interface AssetStore {
  getAsset(id: string): Promise<AssetRow | null>;
  searchAssets(i: { q: string; limit: number; offset: number }): Promise<LibraryAssetRow[]>;
}
```

- [ ] **Step 5: Implement `searchAssets` in the D1 store**

In `projects/worker/src/d1.ts`:

Change the import line to:

```ts
import type { AssetRow, AssetStore, LibraryAssetRow, QueryStore, KeyStore } from "./types";
```

Add above `makeD1Stores`:

```ts
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
```

Replace the `assets` store object with:

```ts
const assets: AssetStore = {
  async getAsset(id) {
    const row = await db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).bind(id).first();
    return (row as AssetRow) ?? null;
  },
  async searchAssets({ q, limit, offset }) {
    const tail = "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
    const stmt = q
      ? db.prepare(`SELECT ${ASSET_COLS}, created_at FROM assets WHERE prompt LIKE ? ESCAPE '\\' ${tail}`)
          .bind(`%${escapeLike(q)}%`, limit, offset)
      : db.prepare(`SELECT ${ASSET_COLS}, created_at FROM assets ${tail}`).bind(limit, offset);
    const { results } = await stmt.all();
    return (results ?? []) as LibraryAssetRow[];
  },
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd projects/worker && npm test -- d1.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Update the shared test fake so the whole suite compiles**

`test/fakes.ts` builds a `Services` whose `assets` must now include `searchAssets`. Replace the body of `fakeServices` in `projects/worker/test/fakes.ts` with:

```ts
export function fakeServices(overrides: Partial<Services> = {}): Services {
  const assets = new Map<string, AssetRow>();
  const libraryRows: LibraryAssetRow[] = [];
  const searchCalls: { q: string; limit: number; offset: number }[] = [];
  const recorded: any[] = [];
  const keyHashes = new Set<string>();
  const matches: Match[] = [];
  const base: Services = {
    clip: { textEmbed: async () => [0.1, 0.2, 0.3] },
    vectorize: { query: async () => matches },
    assets: {
      getAsset: async (id) => assets.get(id) ?? null,
      searchAssets: async (i) => { searchCalls.push(i); return libraryRows.slice(i.offset, i.offset + i.limit); },
    },
    queries: { recordQuery: async (i) => { recorded.push(i); return i.generate; } },
    keys: { verifyKey: async (h) => keyHashes.has(h), addKey: async (h) => { keyHashes.add(h); } },
    rateLimiter: { limit: async () => true },
  };
  // expose internals for assertions
  (base as any)._assets = assets;
  (base as any)._libraryRows = libraryRows;
  (base as any)._searchCalls = searchCalls;
  (base as any)._recorded = recorded;
  (base as any)._matches = matches;
  (base as any)._keyHashes = keyHashes;
  return { ...base, ...overrides };
}
```

And change its import line to:

```ts
import type { Services, AssetRow, LibraryAssetRow, Match } from "../src/types";
```

- [ ] **Step 8: Run the full suite**

Run: `cd projects/worker && npm test`
Expected: PASS (everything).

- [ ] **Step 9: Commit**

```bash
git add projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/test/d1.test.ts projects/worker/test/fakes.ts
git commit -m "feat(worker): add searchAssets D1 store method for library search"
```

---

### Task 2: `handleLibrarySearch` handler

**Files:**
- Create: `projects/worker/src/library.ts`
- Test: `projects/worker/test/library.test.ts` (new)

**Interfaces:**
- Consumes: `Services` from `src/types.ts`; `fakeServices` from `test/fakes.ts` with `_libraryRows` / `_searchCalls` internals (Task 1).
- Produces: `handleLibrarySearch(url: URL, s: Services): Promise<Response>` — 200 `{ images: LibraryAssetRow[], has_more: boolean }`, 400 JSON `{ error }` on bad params. Fetches `limit + 1` rows to compute `has_more`.

- [ ] **Step 1: Write the failing tests**

Create `projects/worker/test/library.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npm test -- library.test.ts`
Expected: FAIL — `Cannot find module '../src/library'`.

- [ ] **Step 3: Implement the handler**

Create `projects/worker/src/library.ts`:

```ts
import type { Services } from "./types";

export async function handleLibrarySearch(url: URL, s: Services): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");

  let limit = 24;
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n)) return Response.json({ error: "limit must be a number" }, { status: 400 });
    limit = Math.min(60, Math.max(1, Math.floor(n)));
  }
  let offset = 0;
  if (rawOffset != null) {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) {
      return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    }
    offset = n;
  }

  const rows = await s.assets.searchAssets({ q, limit: limit + 1, offset });
  const has_more = rows.length > limit;
  return Response.json({ images: rows.slice(0, limit), has_more });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npm test -- library.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd projects/worker && npm test` — expected PASS. Then:

```bash
git add projects/worker/src/library.ts projects/worker/test/library.test.ts
git commit -m "feat(worker): add public library search handler"
```

---

### Task 3: `handleLibraryDownload` handler

**Files:**
- Modify: `projects/worker/src/library.ts`
- Test: `projects/worker/test/library.test.ts`

**Interfaces:**
- Consumes: `Services.assets.getAsset` (existing), `fakeServices` internals `_assets`.
- Produces:
  - `handleLibraryDownload(id: string, s: Services, fetchFn: (url: string) => Promise<Response>): Promise<Response>` — 404 unknown id, 502 upstream failure, otherwise streams the upstream body with `Content-Type` (upstream header → `asset.mime` → `application/octet-stream`) and `Content-Disposition: attachment; filename="<slug>.<ext>"`.
  - `assetFilename(asset: { id: string; prompt: string; mime: string | null }, contentType: string | null): string` (exported for tests).

- [ ] **Step 1: Write the failing tests**

In `projects/worker/test/library.test.ts`, change the import of `../src/library` to:

```ts
import { handleLibrarySearch, handleLibraryDownload, assetFilename } from "../src/library";
```

Then append:

```ts
function okUpstream(contentType: string | null = "image/webp"): (url: string) => Promise<Response> {
  return async () => new Response("BYTES", { status: 200, headers: contentType ? { "content-type": contentType } : {} });
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
```

Note: `libRow` sets `url: "https://cdn/large.webp"` and `mime: "image/webp"`. `Map<string, AssetRow>` accepts `LibraryAssetRow` since it extends `AssetRow`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npm test -- library.test.ts`
Expected: FAIL — `handleLibraryDownload` / `assetFilename` not exported.

- [ ] **Step 3: Implement download + filename helper**

Append to `projects/worker/src/library.ts`:

```ts
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function assetFilename(
  asset: { id: string; prompt: string; mime: string | null },
  contentType: string | null
): string {
  const slug = asset.prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const mime = (contentType ?? asset.mime ?? "").split(";")[0].trim();
  const ext = MIME_EXT[mime] ?? "bin";
  return `${slug || asset.id}.${ext}`;
}

export async function handleLibraryDownload(
  id: string,
  s: Services,
  fetchFn: (url: string) => Promise<Response>
): Promise<Response> {
  const asset = await s.assets.getAsset(id);
  if (!asset) return Response.json({ error: "not found" }, { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetchFn(asset.url);
  } catch {
    return Response.json({ error: "upstream fetch failed" }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: "upstream fetch failed" }, { status: 502 });

  const contentType = upstream.headers.get("content-type");
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType ?? asset.mime ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${assetFilename(asset, contentType)}"`,
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npm test -- library.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd projects/worker && npm test` — expected PASS. Then:

```bash
git add projects/worker/src/library.ts projects/worker/test/library.test.ts
git commit -m "feat(worker): add library download proxy with attachment filename"
```

---

### Task 4: Route the library endpoints

**Files:**
- Modify: `projects/worker/src/index.ts`
- Test: `projects/worker/test/router.test.ts`

**Interfaces:**
- Consumes: `handleLibrarySearch(url, services)` (Task 2), `handleLibraryDownload(id, services, fetchFn)` (Task 3), existing `buildServices(env)`.
- Produces: worker routes `GET /v1/library` and `GET /v1/library/:id/download`, placed before the `/v1/` catch-all 404. Non-GET methods fall through to the 404. The download id is `decodeURIComponent`-ed.

- [ ] **Step 1: Write the failing tests**

Append to `projects/worker/test/router.test.ts`:

```ts
it("library: GET returns images/has_more, POST is 404", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"), fakeEnv());
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.images).toEqual([]);
  expect(j.has_more).toBe(false);
  const post = await worker.fetch(new Request("https://x/v1/library", { method: "POST" }), fakeEnv());
  expect(post.status).toBe(404);
});

it("library: invalid limit -> 400", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library?limit=abc"), fakeEnv());
  expect(res.status).toBe(400);
});

it("library download: unknown id -> 404", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library/nope/download"), fakeEnv());
  expect(res.status).toBe(404);
});
```

Note: the existing `fakeEnv` DB stub already answers `.all()` with `{ results: [] }` and `.first()` with `null`, which is exactly what these tests need.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npm test -- router.test.ts`
Expected: the three new tests FAIL (the search/download paths currently hit the `/v1/` 404, so statuses are 404 instead of 200/400).

- [ ] **Step 3: Add the routes**

In `projects/worker/src/index.ts`, add to the imports:

```ts
import { handleLibrarySearch, handleLibraryDownload } from "./library";
```

Insert after the `/v1/meta/stars` block (line 72) and before the keygen block:

```ts
if (url.pathname === "/v1/library" && request.method === "GET") {
  return await handleLibrarySearch(url, buildServices(env));
}

const dl = url.pathname.match(/^\/v1\/library\/([^/]+)\/download$/);
if (dl && request.method === "GET") {
  return await handleLibraryDownload(decodeURIComponent(dl[1]), buildServices(env), (u) => fetch(u));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npm test -- router.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd projects/worker && npm test` — expected PASS. Then:

```bash
git add projects/worker/src/index.ts projects/worker/test/router.test.ts
git commit -m "feat(worker): route public library search and download endpoints"
```

---

### Task 5: Frontend `#/library` view

**Files:**
- Modify: `projects/worker/public/index.html`

**Interfaces:**
- Consumes: `GET /v1/library?q=&limit=&offset=` → `{ images, has_more }`; `GET /v1/library/:id/download`; existing SPA helpers `ROUTES`, `PATH_TO_HASH`, `escapeHtml(str)` (already defined near line 3785), CSS tokens/classes per Global Constraints.
- Produces: `view-library` view, `nav-library` header link, footer link, and JS functions `initLibrary()`, `onLibraryInput(value)`, `onLibraryKeydown(event)`, `searchLibrary(q)`, `loadLibrary(append)`, `loadMoreLibrary()`, `libraryCard(img)`.

- [ ] **Step 1: Add the nav and footer links**

In `projects/worker/public/index.html`, in the header nav (line ~2153), directly after
`<a href="#/pricing" id="nav-pricing" class="nav-link">Pricing</a>` add:

```html
<a href="#/library" id="nav-library" class="nav-link">Library</a>
```

In the footer links (line ~3505), directly after `<a href="#/playground">Playground</a>` add:

```html
<a href="#/library">Library</a>
```

- [ ] **Step 2: Add the view markup**

Insert immediately before `<!-- VIEW 3: ACCOUNT & SETTINGS -->` (line ~2946):

```html
    <!-- VIEW: LIBRARY -->
    <div id="view-library" class="spa-view" style="display: none;">
      <div class="view-pad">
        <div class="page-head">
          <div class="eyebrow"><span class="tick tick-red"></span><span class="tick tick-ink"></span>Library</div>
          <h1 class="section-title">Browse the shared library</h1>
          <p class="section-sub">Every image the cache has ever served, searchable by prompt. Download anything — it's all public-domain PD12M or cache-generated.</p>
        </div>

        <div class="library-bar">
          <input id="library-search" class="input-field" type="search" placeholder="Search prompts, e.g. flamingo sunset…"
                 oninput="onLibraryInput(this.value)" onkeydown="onLibraryKeydown(event)">
        </div>

        <div id="library-grid" class="library-grid"></div>
        <div id="library-status" class="library-status" style="display: none;"></div>
        <button id="library-more" class="btn library-more" style="display: none;" onclick="loadMoreLibrary()">Load more</button>
      </div>
    </div>
```

- [ ] **Step 3: Add the CSS**

Add to the stylesheet, after the `.view-pad` rule (line ~399):

```css
    /* ============ Library ============ */
    .library-bar { max-width: 560px; margin: 0 auto 28px; }
    .library-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    @media (max-width: 1000px) { .library-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 640px) { .library-grid { grid-template-columns: repeat(2, 1fr); } }
    .library-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .library-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--paper); }
    .library-meta { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
    .library-prompt {
      font-size: 0.8125rem; color: var(--ink); line-height: 1.35; margin: 0;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      min-height: calc(2 * 1.35em);
    }
    .library-tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .library-tag {
      font-size: 0.6875rem; color: var(--muted); background: var(--paper);
      border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px;
    }
    .library-download {
      margin-top: auto; height: 34px; font-size: 0.8125rem; text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--ink); color: #fff; border-radius: 8px;
    }
    .library-download:hover { background: var(--red); }
    .library-status { text-align: center; color: var(--muted); padding: 40px 0; font-size: 0.9375rem; }
    .library-status a { color: var(--red); }
    .library-more { display: block; margin: 28px auto 0; background: var(--paper); border: 1px solid var(--line); color: var(--ink); padding: 0 24px; height: 40px; }
```

- [ ] **Step 4: Register the route**

In the `ROUTES` map (line ~3548), after the `'#/pricing'` entry add:

```js
      '#/library':    { view: 'view-library', link: 'nav-library', onShow: initLibrary },
```

In `PATH_TO_HASH` (line ~3559) add `'/library': '#/library',`.

- [ ] **Step 5: Add the JS**

Add a new section to the main `<script>` block (e.g. after the `escapeHtml` function, line ~3790):

```js
    // ---- Library ----
    const LIB_PAGE_SIZE = 24;
    let libQuery = '', libOffset = 0, libLoaded = false, libSeq = 0, libDebounce = null;

    function initLibrary() { if (!libLoaded) searchLibrary(''); }

    function onLibraryInput(value) {
      clearTimeout(libDebounce);
      libDebounce = setTimeout(() => searchLibrary(value.trim()), 300);
    }
    function onLibraryKeydown(e) {
      if (e.key === 'Enter') { clearTimeout(libDebounce); searchLibrary(e.target.value.trim()); }
    }

    function searchLibrary(q) { libQuery = q; libOffset = 0; loadLibrary(false); }
    function loadMoreLibrary() { loadLibrary(true); }

    async function loadLibrary(append) {
      const seq = ++libSeq;
      const grid = document.getElementById('library-grid');
      const status = document.getElementById('library-status');
      const moreBtn = document.getElementById('library-more');
      if (!append) { grid.innerHTML = ''; libOffset = 0; moreBtn.style.display = 'none'; }
      status.textContent = 'Loading…';
      status.style.display = 'block';
      try {
        const params = new URLSearchParams({ limit: LIB_PAGE_SIZE, offset: libOffset });
        if (libQuery) params.set('q', libQuery);
        const res = await fetch('/v1/library?' + params);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (seq !== libSeq) return; // superseded by a newer search
        libLoaded = true;
        libOffset += data.images.length;
        grid.insertAdjacentHTML('beforeend', data.images.map(libraryCard).join(''));
        if (grid.children.length) {
          status.style.display = 'none';
        } else {
          status.textContent = libQuery ? 'No images match “' + libQuery + '”.' : 'The library is empty.';
        }
        moreBtn.style.display = data.has_more ? 'block' : 'none';
      } catch (err) {
        if (seq !== libSeq) return;
        status.innerHTML = 'Could not load the library. <a href="javascript:void 0" onclick="loadLibrary(' + append + ')">Retry</a>';
        status.style.display = 'block';
      }
    }

    function libraryCard(img) {
      const thumb = img.thumb_url || img.medium_url || img.url;
      const tags = [img.model_used, img.source].filter(Boolean)
        .map(t => '<span class="library-tag">' + escapeHtml(t) + '</span>').join('');
      return '<div class="library-card">' +
        '<img class="library-thumb" loading="lazy" src="' + escapeHtml(thumb) + '" alt="' + escapeHtml(img.prompt) + '">' +
        '<div class="library-meta">' +
          '<p class="library-prompt" title="' + escapeHtml(img.prompt) + '">' + escapeHtml(img.prompt) + '</p>' +
          '<div class="library-tags">' + tags + '</div>' +
          '<a class="library-download" href="/v1/library/' + encodeURIComponent(img.id) + '/download">Download</a>' +
        '</div></div>';
    }
```

Note: `status.textContent` when showing "no match" uses curly quotes (`“`/`”`) — `libQuery` goes through `textContent`, so no escaping is needed there.

- [ ] **Step 6: Seed local D1 with demo rows for manual verification**

The repo already ships three images in `public/assets/`. Seed local D1 so the page has data (run from `projects/worker/`):

```bash
npx wrangler d1 execute sharedcache --local --command "INSERT OR REPLACE INTO assets (id, prompt, source, url, thumb_url, mime) VALUES ('demo-1','A flamingo standing in shallow water at sunset','pd12m','http://localhost:8787/assets/match-flamingo.webp','http://localhost:8787/assets/match-flamingo.webp','image/webp'), ('demo-2','A cat and a dog sitting together on a couch','pd12m','http://localhost:8787/assets/match-cat-dog.webp','http://localhost:8787/assets/match-cat-dog.webp','image/webp'), ('demo-3','Grandpa giving an enthusiastic thumbs up','pd12m','http://localhost:8787/assets/grandpa-thumbs-up.webp','http://localhost:8787/assets/grandpa-thumbs-up.webp','image/webp');"
```

- [ ] **Step 7: Manually verify in the running app**

With `npx wrangler dev --port 8787` running (restart it if it was started before these changes):

1. `curl -s 'http://localhost:8787/v1/library?q=flamingo'` → JSON with the flamingo row, `has_more: false`.
2. `curl -sI 'http://localhost:8787/v1/library/demo-1/download'` → `content-disposition: attachment; filename="a-flamingo-standing-in-shallow-water-at-sunset.webp"`.
   (If the worker's loopback fetch to its own localhost URL misbehaves under wrangler dev, note it and rely on the unit tests — production asset URLs are external.)
3. Open `http://localhost:8787/#/library` in a browser (or Playwright): the grid shows 3 cards, typing `cat` narrows to 1, clearing shows all, Download button downloads the file.
4. Check the Library nav link highlights and works from the mobile menu (< 900px width).

Expected: all four behave as described.

- [ ] **Step 8: Run the full suite and commit**

Run: `cd projects/worker && npm test` — expected PASS. Then:

```bash
git add projects/worker/public/index.html
git commit -m "feat(site): add library page with prompt search and image downloads"
```
