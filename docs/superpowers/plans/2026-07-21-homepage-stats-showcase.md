# Homepage Stats + Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /v1/home` (live library count + top-liked rehosted showcase, edge-cached daily) and a landing-page section right after the hero that renders it.

**Architecture:** Two new `AssetStore` methods back a small `home.ts` route handler; `index.ts` wires `/v1/home` with the same `caches.default` idiom as `/v1/meta/stars`. The SPA fetches once on init and degrades to static copy on any failure.

**Tech Stack:** Cloudflare Worker (TypeScript), D1 via `makeD1Stores`, vitest (fakes + real-schema SQLite harness), vanilla-JS SPA in `projects/worker/public/index.html`.

**Spec:** `docs/superpowers/specs/2026-07-21-homepage-stats-showcase-design.md`

## Global Constraints

- All asset reads go through the `live_assets` view — never the raw `assets` table (tombstone rule).
- Unscoped public reads exclude collection assets: `collection_id IS NULL` (parity with `browseByLikes`, d1.ts:106).
- Showcase rows are `locally_cached = 1` only — tiles must always serve fast B2 thumbs, never hotlinked originals.
- `/v1/home` is GET-only, public, unauthenticated, and NOT behind any rate limiter (the edge cache absorbs traffic).
- Cache: `Cache-Control: public, max-age=86400` on the response + explicit `caches.default` put in `index.ts` (Workers do not auto-cache handler responses; mirror the `/v1/meta/stars` idiom at index.ts:85-104). No `stale-while-revalidate` (Workers Cache API ignores it).
- Copy must never overstate the count. Static fallback copy is exactly: `500,000+`.
- No new generation knobs, no new params on existing endpoints, no `wrangler.toml [vars]` additions.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run all commands from `projects/worker/`.

---

### Task 0: Amend spec with planning refinements

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-homepage-stats-showcase-design.md`

Two refinements were found while mapping the plan to real code. Record them in the spec so it stays the source of truth.

- [ ] **Step 1: Edit the spec**

In the `## Endpoint` section, change the `image_count` bullet to:

```markdown
- `image_count`: `SELECT COUNT(*) FROM live_assets WHERE collection_id IS NULL`
  (tombstone-aware view, and collection assets are excluded — parity with the
  rule that unscoped browse never surfaces collection assets).
```

Add `AND collection_id IS NULL` to the showcase restriction sentence (showcase bullet), i.e. "restricted to `locally_cached = 1 AND collection_id IS NULL`".

Replace the whole `### Caching` paragraph with:

```markdown
### Caching

`Cache-Control: public, max-age=86400` on the response, plus an explicit
`caches.default` match/put in `index.ts` keyed on an internal URL — the same
idiom as `/v1/meta/stars` (Workers do not auto-edge-cache handler responses;
`stale-while-revalidate` is ignored by the Workers Cache API, so it is not
used). Consequences (accepted): D1 sees roughly one query per colo per day;
newly liked images take up to a day to show on the homepage.
```

- [ ] **Step 2: Commit**

```bash
git add ../../docs/superpowers/specs/2026-07-21-homepage-stats-showcase-design.md
git commit -m "docs(spec): homepage showcase — collection_id IS NULL + Cache API idiom

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: Store layer — `countLibraryAssets` + `showcaseAssets`

**Files:**
- Modify: `projects/worker/src/types.ts` (AssetStore interface, after `browseByLikes` at :69)
- Modify: `projects/worker/src/d1.ts` (after `browseByLikes` impl at :104-112)
- Modify: `projects/worker/test/fakes.ts` (assets store, after `browseByLikes` at :81)
- Create: `projects/worker/test/home.test.ts`

**Interfaces:**
- Consumes: `makeD1Stores(db)` from `src/d1.ts`, `realDb()` from `test/real-d1.ts`, `ASSET_COLS` const (d1.ts:11).
- Produces (Task 2 relies on these exact signatures on `AssetStore`):
  - `countLibraryAssets(): Promise<number>`
  - `showcaseAssets(limit: number): Promise<LibraryAssetRow[]>`

- [ ] **Step 1: Write the failing real-schema tests**

Create `test/home.test.ts`:

```typescript
import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";
import { realDb } from "./real-d1";

function seedUser(db: any, id = "usr_1") {
  db._raw.exec(`INSERT INTO users (id, email) VALUES ('${id}', '${id}@example.com')`);
}

// Insert a public-library row via the one real write path, then shape it with
// raw SQL (insertGenerated always writes locally_cached=0 / like_count=0).
async function seedAsset(db: any, assets: any, id: string, over: { cached?: number; likes?: number; collectionId?: string | null } = {}) {
  await assets.insertGenerated({
    id, prompt: `p-${id}`, sourceUrl: `https://x/${id}.webp`, mime: "image/webp",
    width: 1024, height: 1024, modelUsed: "m", provider: "openai", priceUsd: 0.04,
    createdBy: "usr_1", collectionId: over.collectionId ?? null,
  });
  if (over.cached) db._raw.exec(`UPDATE assets SET locally_cached = 1 WHERE id = '${id}'`);
  if (over.likes) db._raw.exec(`UPDATE assets SET like_count = ${over.likes} WHERE id = '${id}'`);
}

it("countLibraryAssets: counts live public rows; excludes tombstoned and collection assets", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_1", ownerUserId: "usr_1", name: "n", themePrompt: "" });
  await seedAsset(db, assets, "pub1");
  await seedAsset(db, assets, "pub2");
  await seedAsset(db, assets, "dead", {});
  await seedAsset(db, assets, "scoped", { collectionId: "col_1" });
  await assets.tombstoneAsset("dead");
  expect(await assets.countLibraryAssets()).toBe(2);
});

it("showcaseAssets: cached-only, like-ranked, newest tiebreak, collection/tombstone excluded, limit respected", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_1", ownerUserId: "usr_1", name: "n", themePrompt: "" });
  await seedAsset(db, assets, "hot", { cached: 1, likes: 5 });
  await seedAsset(db, assets, "warm", { cached: 1, likes: 2 });
  await seedAsset(db, assets, "plain_a", { cached: 1 });
  await seedAsset(db, assets, "plain_b", { cached: 1 });
  await seedAsset(db, assets, "uncached_liked", { likes: 9 });          // not rehosted -> excluded
  await seedAsset(db, assets, "scoped", { cached: 1, likes: 9, collectionId: "col_1" }); // excluded
  await seedAsset(db, assets, "dead", { cached: 1, likes: 9 });
  await assets.tombstoneAsset("dead");
  // Deterministic created_at, newest-first among the unliked pair.
  db._raw.exec("UPDATE assets SET created_at = '2026-07-01 00:00:00' WHERE id = 'plain_a'");
  db._raw.exec("UPDATE assets SET created_at = '2026-07-02 00:00:00' WHERE id = 'plain_b'");

  const rows = await assets.showcaseAssets(3);
  expect(rows.map((r) => r.id)).toEqual(["hot", "warm", "plain_b"]);

  const all = await assets.showcaseAssets(8);
  expect(all.map((r) => r.id)).toEqual(["hot", "warm", "plain_b", "plain_a"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/home.test.ts`
Expected: FAIL — `assets.countLibraryAssets is not a function` (TypeScript may also flag the missing interface members).

- [ ] **Step 3: Add the interface members**

In `src/types.ts`, immediately after the `browseByLikes` line (:69), inside `AssetStore`:

```typescript
  /** Public library size for /v1/home — live, unscoped rows only. */
  countLibraryAssets(): Promise<number>;
  /** Homepage strip: top-liked rehosted (locally_cached=1) public rows,
   *  newest-first tiebreak — tiles must always serve fast B2 thumbs. */
  showcaseAssets(limit: number): Promise<LibraryAssetRow[]>;
```

- [ ] **Step 4: Implement in D1**

In `src/d1.ts`, immediately after the `browseByLikes` implementation (:112), inside the assets store object:

```typescript
    async countLibraryAssets() {
      const row = await db.prepare(
        "SELECT COUNT(*) AS n FROM live_assets WHERE collection_id IS NULL"
      ).first<{ n: number }>();
      return row?.n ?? 0;
    },
    async showcaseAssets(limit) {
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at FROM live_assets WHERE collection_id IS NULL AND locally_cached = 1 ORDER BY like_count DESC, created_at DESC, id ASC LIMIT ?`
      ).bind(limit).all<LibraryAssetRow>();
      return results ?? [];
    },
```

- [ ] **Step 5: Implement the fakes**

In `test/fakes.ts`, immediately after the `browseByLikes` fake (:81-86), inside the assets store object (same closures: `libraryRows`, `likeCounts`, `tombstoned`):

```typescript
      countLibraryAssets: async () =>
        libraryRows.filter((r: any) => r.collection_id == null && !tombstoned.includes(r.id)).length,
      showcaseAssets: async (limit) => {
        const scope = libraryRows.filter((r: any) =>
          r.collection_id == null && r.locally_cached === 1 && !tombstoned.includes(r.id));
        const sorted = [...scope].sort((a: any, b: any) =>
          (likeCounts.get(b.id) ?? 0) - (likeCounts.get(a.id) ?? 0) ||
          String(b.created_at).localeCompare(String(a.created_at)) ||
          (a.id < b.id ? -1 : 1));
        return sorted.slice(0, limit).map((r: any) => ({ ...r, like_count: likeCounts.get(r.id) ?? 0 }));
      },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/home.test.ts`
Expected: PASS (2 tests). Then run the full suite: `npm test` — expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/d1.ts test/fakes.ts test/home.test.ts
git commit -m "feat(store): countLibraryAssets + showcaseAssets for /v1/home

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `GET /v1/home` route handler + wiring

**Files:**
- Create: `projects/worker/src/home.ts`
- Modify: `projects/worker/src/index.ts` (insert route after the `/v1/meta/stars` block, :132-135)
- Modify: `projects/worker/test/home.test.ts` (append route tests)

**Interfaces:**
- Consumes: `countLibraryAssets()` / `showcaseAssets(limit)` from Task 1; `assetUrls` from `src/asset-urls.ts`; `LibraryCfg` from `src/library.ts`; `fakeServices()` from `test/fakes.ts`.
- Produces: `handleHome(s: Services, cfg: LibraryCfg): Promise<Response>` and consts `SHOWCASE_LIMIT = 8`, `HOME_CACHE_SECONDS = 86400` exported from `src/home.ts`. Response body: `{ image_count: number, showcase: Array<{ id, thumb_url, medium_url, prompt, like_count }> }`.

- [ ] **Step 1: Append the failing route tests**

Append to `test/home.test.ts`:

```typescript
import { handleHome, SHOWCASE_LIMIT, HOME_CACHE_SECONDS } from "../src/home";
import { fakeServices } from "./fakes";
import type { LibraryAssetRow } from "../src/types";

const BASE = "https://cdn.example.com";
const homeCfg = { assetBaseUrl: BASE };

function libRow(over: Partial<LibraryAssetRow> = {}): LibraryAssetRow {
  return { id: "a1", prompt: "a fox", source: "pd12m", source_id: null,
    model_used: "flux", width: 10, height: 20, like_count: 0,
    mime: "image/webp", source_url: null, locally_cached: 1, created_at: "2026-07-03 00:00:00", ...over };
}

it("home: returns image_count and the documented showcase shape, nothing internal", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow());
  const res = await handleHome(s, homeCfg);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.image_count).toBe(1);
  expect(j.showcase).toHaveLength(1);
  expect(j.showcase[0]).toEqual({
    id: "a1", thumb_url: `${BASE}/assets/a1/thumb.webp`, medium_url: `${BASE}/assets/a1/medium.webp`,
    prompt: "a fox", like_count: 0,
  });
});

it("home: counts uncached rows but never showcases them", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow({ id: "cached", locally_cached: 1 }));
  (s as any)._libraryRows.push(libRow({ id: "raw", locally_cached: 0 }));
  const j: any = await (await handleHome(s, homeCfg)).json();
  expect(j.image_count).toBe(2);
  expect(j.showcase.map((x: any) => x.id)).toEqual(["cached"]);
});

it("home: caps the showcase at SHOWCASE_LIMIT", async () => {
  const s = fakeServices();
  for (let i = 0; i < SHOWCASE_LIMIT + 3; i++) (s as any)._libraryRows.push(libRow({ id: "a" + i }));
  const j: any = await (await handleHome(s, homeCfg)).json();
  expect(j.showcase).toHaveLength(SHOWCASE_LIMIT);
});

it("home: sends the daily public cache header", async () => {
  const res = await handleHome(fakeServices(), homeCfg);
  expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${HOME_CACHE_SECONDS}`);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/home.test.ts`
Expected: FAIL — cannot resolve `../src/home`. (Task 1's two tests still pass.)

- [ ] **Step 3: Implement `src/home.ts`**

```typescript
import type { Services } from "./types";
import type { LibraryCfg } from "./library";
import { assetUrls } from "./asset-urls";

export const SHOWCASE_LIMIT = 8;
export const HOME_CACHE_SECONDS = 86400; // daily — spec 2026-07-21

// Landing-page payload: live public-library count + top-liked rehosted
// showcase. Public and cached for a day (index.ts adds the caches.default
// layer), so D1 sees roughly one query per colo per day.
export async function handleHome(s: Services, cfg: LibraryCfg): Promise<Response> {
  const [image_count, rows] = await Promise.all([
    s.assets.countLibraryAssets(),
    s.assets.showcaseAssets(SHOWCASE_LIMIT),
  ]);
  const showcase = rows.map((r) => {
    const u = assetUrls(r, cfg.assetBaseUrl);
    return { id: r.id, thumb_url: u.thumb_url, medium_url: u.medium_url, prompt: r.prompt, like_count: r.like_count };
  });
  return Response.json({ image_count, showcase }, {
    headers: { "Cache-Control": `public, max-age=${HOME_CACHE_SECONDS}` },
  });
}
```

- [ ] **Step 4: Wire the route in `src/index.ts`**

Add the import next to the other route imports (top of file):

```typescript
import { handleHome } from "./home";
```

Insert directly AFTER the `/v1/meta/stars` block (:132-135) and BEFORE the auth routes — `/v1/home` must stay outside `libraryAccess` and every rate limiter:

```typescript
      // Landing-page stats. Public + cached a day via the same Cache API
      // idiom as /v1/meta/stars (Workers don't auto-cache handler responses).
      if (url.pathname === "/v1/home") {
        if (request.method !== "GET") return new Response("Not found", { status: 404 });
        const cacheKey = new Request("https://wagmiphotos.internal/v1/home");
        const cache = (globalThis as any).caches?.default;
        if (cache) {
          const hit = await cache.match(cacheKey);
          if (hit) return hit;
        }
        const res = await handleHome(services, { assetBaseUrl: env.ASSET_BASE_URL });
        if (cache && res.ok) await cache.put(cacheKey, res.clone());
        return res;
      }
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, including the 4 new route tests.

- [ ] **Step 6: Commit**

```bash
git add src/home.ts src/index.ts test/home.test.ts
git commit -m "feat(api): GET /v1/home — library count + top-liked showcase, edge-cached daily

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Landing-page section (markup + CSS + JS)

**Files:**
- Modify: `projects/worker/public/index.html` — four insertions listed below.

**Interfaces:**
- Consumes: `GET /v1/home` (Task 2 shape); existing helpers `escapeHtml(str)` (index.html:4209); existing CSS vars `--muted/--paper/--line`; classes `.section`, `.section-title`, `.eyebrow`, `.tick`, `.btn-solid`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Insert the section markup**

In `public/index.html`, the hero section closes at :2512 (`</section>` followed by the `<!-- Closest match, not always exact -->` comment). Insert BETWEEN them, still inside `#view-home`:

```html
      <!-- Live library stats + top-liked showcase (spec 2026-07-21) -->
      <section class="section" id="library-live">
        <div class="eyebrow"><span class="tick tick-red"></span><span class="tick tick-ink"></span>The library right now</div>
        <h2 class="section-title"><span id="home-count">500,000+</span> images. <em>And counting.</em></h2>
        <p class="live-sub">Every one openly licensed and free to use. The strip below is what the
          community is liking right now — tap any image to explore the rest.</p>
        <div class="live-strip" id="home-strip" hidden></div>
        <div class="live-cta"><a href="#/library" class="btn-solid">Browse the library →</a></div>
      </section>
```

Note: the static `500,000+` text IS the failure fallback — the JS only ever upgrades it.

- [ ] **Step 2: Add the CSS**

Directly after the `.section` rule (`.section { padding: 72px 0 0; }`, :603):

```css
    /* Live library section: count headline + top-liked thumb strip */
    #library-live .live-sub { color: var(--muted); max-width: 560px; margin: 12px 0 24px; }
    #library-live .live-cta { margin-top: 24px; }
    .live-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    @media (min-width: 720px) { .live-strip { grid-template-columns: repeat(8, 1fr); } }
    .live-strip a { display: block; border-radius: 10px; overflow: hidden; background: var(--paper); border: 1px solid var(--line); }
    .live-strip img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; transition: transform 0.25s ease; }
    .live-strip a:hover img, .live-strip a:focus-visible img { transform: scale(1.05); }
```

`aspect-ratio` on every tile = zero layout shift while thumbs lazy-load.

- [ ] **Step 3: Extend the reduced-motion block**

Inside `@media (prefers-reduced-motion: reduce)` (:806-819), extend the two existing image rules:

Change:
```css
      .library-thumb, .coll-tile img, .imgmodal-img { transition: none; }
```
to:
```css
      .library-thumb, .coll-tile img, .imgmodal-img, .live-strip img { transition: none; }
```

Change:
```css
      .library-thumb-btn:hover .library-thumb,
      .library-thumb-btn:focus-visible .library-thumb,
      .coll-tile:hover img, .coll-tile:focus-visible img { transform: none; }
```
to:
```css
      .library-thumb-btn:hover .library-thumb,
      .library-thumb-btn:focus-visible .library-thumb,
      .coll-tile:hover img, .coll-tile:focus-visible img,
      .live-strip a:hover img, .live-strip a:focus-visible img { transform: none; }
```

- [ ] **Step 4: Add the JS**

Directly after the `loadStars()` function (ends :4014):

```javascript
    // Landing stats: /v1/home is cached at the edge for a day. On any failure
    // the section keeps its static "500,000+" copy and the strip stays hidden.
    async function loadHomeSection() {
      const countEl = document.getElementById('home-count');
      const strip = document.getElementById('home-strip');
      if (!countEl || !strip) return;
      try {
        const r = await fetch('/v1/home');
        if (!r.ok) return;
        const { image_count, showcase } = await r.json();
        if (typeof image_count === 'number' && image_count > 0) {
          // Count up only once the headline scrolls into view.
          const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) { io.disconnect(); animateCount(countEl, image_count); }
          }, { threshold: 0.3 });
          io.observe(countEl);
        }
        if (Array.isArray(showcase) && showcase.length) {
          strip.innerHTML = showcase.map((img) =>
            '<a href="#/library" aria-label="View in library: ' + escapeHtml(img.prompt || 'image') + '">' +
            '<img loading="lazy" src="' + escapeHtml(img.thumb_url || img.medium_url || '') + '" alt="' + escapeHtml(img.prompt || '') + '">' +
            '</a>').join('');
          strip.hidden = false;
        }
      } catch { /* non-fatal — static copy stands */ }
    }
    function animateCount(el, target) {
      const done = () => { el.textContent = target.toLocaleString('en-US'); };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
      const dur = 1200, t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString('en-US');
        if (p < 1) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    }
```

- [ ] **Step 5: Call it at init**

At :4080, next to the existing fire-and-forget:

```javascript
      loadStars();   // fire-and-forget; independent of auth
```
add below it:
```javascript
      loadHomeSection();   // fire-and-forget; landing section degrades to static copy
```

- [ ] **Step 6: Verify**

Run: `npm test` — expected: all pass (no worker changes in this task; guards against accidental breakage).
Manual (optional but recommended): boot local dev per the `running-locally` skill (`npx wrangler dev --local` with `.dev.vars`), open the homepage, and check: section renders after the hero; count animates (or static `500,000+` if the local DB is empty); no horizontal overflow at mobile width.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(spa): live library count + top-liked showcase section after hero

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Deploy + prod smoke (CONFIRM WITH JORIS FIRST)

**Files:** none (operational).

Do not run the deploy without an explicit go-ahead in the session.

- [ ] **Step 1: Push and deploy**

```bash
git push origin main
npx wrangler deploy
```
Expected: new version ID printed.

- [ ] **Step 2: Smoke the endpoint**

```bash
curl -s -D - https://wagmi.photos/v1/home -o /tmp/home.json | grep -i cache-control
cat /tmp/home.json | head -c 400
```
Expected: `Cache-Control: public, max-age=86400`; JSON with `image_count` ≈ 511k and `showcase` of up to 8 entries whose `thumb_url` starts with `https://cdn.wagmi.photos/` (today the pool is the ~1k rehosted rows; likes reorder it later — up to a day behind due to the cache).

- [ ] **Step 3: Smoke the page**

```bash
curl -s https://wagmi.photos/ | grep -c "library-live"
```
Expected: ≥ 1 (allow a minute for stale edge copies, as seen with the modal fix).
Then a human eyeball: homepage shows the section, count animates, tiles load fast, clicking a tile lands on `#/library`.

- [ ] **Step 4: Remind Joris to seed the showcase**

The strip currently falls back to newest-rehosted. To curate it: log in, browse the library, like ~10 favourites — they surface on the homepage within a day (edge cache expiry). Note for later: liking an un-rehosted image won't showcase it until the bulk rehost sweep catches it (next workstream).
