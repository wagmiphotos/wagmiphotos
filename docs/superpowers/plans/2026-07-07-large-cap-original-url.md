# Large-Cap + Original-URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the rehosted `large` variant at 2048px longest-side and expose the source image URL as `original_url` in API responses and the playground.

**Architecture:** The cap lives inside `derive_sizes` (Python) so every caller — rehost pass and generation — inherits it; generated images are 1024px so only rehosted content changes. On the Worker side, `assetUrls()` is the single URL-derivation point: it gains an `original_url` field which `handler.ts` (generate response) and `library.ts` (library items) pass through, and the playground renders it as a quiet "View original ↗" link.

**Tech Stack:** Python 3.11 + Pillow (uv workspace, pytest), Cloudflare Worker TypeScript (vitest), vanilla-JS playground in `projects/worker/public/index.html`.

**Spec:** `docs/superpowers/specs/2026-07-07-large-cap-original-url-design.md`

## Global Constraints

- Cap value: **2048px longest side**, constant `MAX_LARGE_DIM = 2048` in `processor.py`. Python-only — do NOT add it to `contract.json`.
- Never upscale: sources ≤2048px keep their exact dimensions (PIL `thumbnail` semantics).
- Field name is exactly `original_url`, top-level next to `sizes` in the generate response and a flat field on library items — never inside `sizes`.
- `original_url` = `source_url ?? null`, populated regardless of `locally_cached`; `null` for generated assets.
- API change is additive only; no D1 migration; already-rehosted full-res rows are left as-is.
- Python tests run from the repo root: `uv run pytest …`. Worker tests run from `projects/worker`: `npm test -- <file>`.

---

### Task 1: Cap `large` at 2048px in `derive_sizes`

**Files:**
- Modify: `projects/generation/src/wagmiphotos/generation/processor.py`
- Test: `projects/generation/tests/test_processor.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `derive_sizes(image_bytes: bytes, max_dim: int = MAX_LARGE_DIM) -> dict[str, bytes]` and module constant `MAX_LARGE_DIM = 2048`. Existing callers (`worker.py` rehost + generate paths) keep calling `derive_sizes(original)` with no second argument — no caller changes.

- [ ] **Step 1: Write the failing tests**

Append to `projects/generation/tests/test_processor.py` (the `_png` helper already exists at the top of the file):

```python
def test_derive_sizes_caps_large_at_2048():
    out = derive_sizes(_png(3000, 1500))
    assert Image.open(io.BytesIO(out["large"])).size == (2048, 1024)

def test_derive_sizes_never_upscales_large():
    out = derive_sizes(_png(2000, 1000))
    assert Image.open(io.BytesIO(out["large"])).size == (2000, 1000)

def test_max_large_dim_constant():
    assert processor.MAX_LARGE_DIM == 2048
```

- [ ] **Step 2: Run tests to verify they fail**

Run (repo root): `uv run pytest projects/generation/tests/test_processor.py -q`
Expected: `test_derive_sizes_caps_large_at_2048` FAILS (large is 3000x1500), `test_max_large_dim_constant` FAILS with `AttributeError: … has no attribute 'MAX_LARGE_DIM'`; `test_derive_sizes_never_upscales_large` passes already (2000 ≤ 2048).

- [ ] **Step 3: Implement the cap**

Replace `derive_sizes` in `projects/generation/src/wagmiphotos/generation/processor.py` (large now uses the same convert/thumbnail pattern medium and thumb already use):

```python
MAX_LARGE_DIM = 2048

def derive_sizes(image_bytes: bytes, max_dim: int = MAX_LARGE_DIM) -> dict[str, bytes]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        lg = img.convert("RGB"); lg.thumbnail((max_dim, max_dim)); large = _webp(lg, 90)
        med = img.convert("RGB"); med.thumbnail((768, 768)); medium = _webp(med, 85)
        th = img.convert("RGB"); th.thumbnail((256, 256)); thumb = _webp(th, 80)
    return {"thumb": thumb, "medium": medium, "large": large}
```

- [ ] **Step 4: Run the full Python suite**

Run (repo root): `uv run pytest -q`
Expected: PASS. (The full suite, not just test_processor.py — the backfill and generation tests also exercise `derive_sizes` and must not regress. `width`/`height` written to D1 come from `dimensions(sizes["large"])` in `projects/backfill/src/wagmiphotos/backfill/worker.py`, so they now describe the capped large — intended per spec §1.)

- [ ] **Step 5: Commit**

```bash
git add projects/generation/src/wagmiphotos/generation/processor.py projects/generation/tests/test_processor.py
git commit -m "feat(generation): cap derived large variant at 2048px"
```

---

### Task 2: `original_url` in `assetUrls`

**Files:**
- Modify: `projects/worker/src/asset-urls.ts`
- Test: `projects/worker/test/asset-urls.test.ts`

**Interfaces:**
- Consumes: `AssetUrlInput { id, source_url, locally_cached }` (unchanged).
- Produces: `DerivedUrls` gains `original_url: string | null` — always `source_url ?? null`, in every branch. Task 3 reads `u.original_url`.

- [ ] **Step 1: Update the exact-shape tests and add new cases**

In `projects/worker/test/asset-urls.test.ts`, the two `toEqual` assertions are exact-shape and must gain the new field; also add a cached-with-source case:

```ts
  it("derives all sizes from the contract templates when locally cached", () => {
    const u = assetUrls({ id: "abc", source_url: null, locally_cached: 1 }, BASE);
    expect(u).toEqual({
      url: `${BASE}/assets/abc/image.webp`,
      thumb_url: `${BASE}/assets/abc/thumb.webp`,
      medium_url: `${BASE}/assets/abc/medium.webp`,
      original_url: null,
    });
    expect(u.url.endsWith(contract.asset_paths.large.replace("{id}", "abc"))).toBe(true);
  });
  it("serves source_url with null sizes when not locally cached", () => {
    expect(assetUrls({ id: "x", source_url: "https://o.example/p.png", locally_cached: 0 }, BASE))
      .toEqual({ url: "https://o.example/p.png", thumb_url: null, medium_url: null,
                 original_url: "https://o.example/p.png" });
  });
  it("keeps original_url pointing at the source after rehost", () => {
    const u = assetUrls({ id: "abc", source_url: "https://o.example/p.png", locally_cached: 1 }, BASE);
    expect(u.url).toBe(`${BASE}/assets/abc/image.webp`);
    expect(u.original_url).toBe("https://o.example/p.png");
  });
```

(The two remaining tests — base-unset fallback and trailing-slash — only assert `.url` and need no edits.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `projects/worker`): `npm test -- test/asset-urls.test.ts`
Expected: 3 FAIL (missing `original_url` key / undefined), 2 pass.

- [ ] **Step 3: Implement**

Replace the interface and function body in `projects/worker/src/asset-urls.ts`:

```ts
export interface DerivedUrls { url: string; thumb_url: string | null; medium_url: string | null; original_url: string | null; }
```

```ts
export function assetUrls(a: AssetUrlInput, baseUrl: string | undefined): DerivedUrls {
  const original_url = a.source_url ?? null;
  if (!a.locally_cached || !baseUrl) {
    if (a.locally_cached && !baseUrl) console.warn("ASSET_BASE_URL unset; serving source_url for", a.id);
    return { url: a.source_url ?? "", thumb_url: null, medium_url: null, original_url };
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/${fill(contract.asset_paths.large, a.id)}`,
    thumb_url: `${base}/${fill(contract.asset_paths.thumb, a.id)}`,
    medium_url: `${base}/${fill(contract.asset_paths.medium, a.id)}`,
    original_url,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `projects/worker`): `npm test -- test/asset-urls.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/asset-urls.ts projects/worker/test/asset-urls.test.ts
git commit -m "feat(worker): derive original_url from source_url in assetUrls"
```

---

### Task 3: Expose `original_url` in generate + library responses

**Files:**
- Modify: `projects/worker/src/handler.ts` (the `Response.json` block near line 75)
- Modify: `projects/worker/src/library.ts` (`publicAsset` + the comment above it, lines 9–19)
- Test: `projects/worker/test/handler.test.ts`, `projects/worker/test/library.test.ts`

**Interfaces:**
- Consumes: `u.original_url` from Task 2's `assetUrls`.
- Produces: generate response `shared_cache.original_url: string | null` (sibling of `sizes`); library item field `original_url: string | null`. Task 4's playground JS reads `sc.original_url` and `img.original_url`.

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/handler.test.ts` — the `asset()` fixture already has `source_url: "https://ext/x.jpg"`. Extend the two hit tests:

In `"hit: score >= floor, cached -> result hit + cost saved"`, after the `sizes` assertion add:

```ts
  expect(j.shared_cache.original_url).toBe("https://ext/x.jpg");
```

In `"hit-not-rehosted: serves source_url, still result hit"`, after the `sizes.thumb` assertion add:

```ts
  expect(j.shared_cache.original_url).toBe("https://ext/x.jpg"); // pre-rehost: same as data[0].url
```

`projects/worker/test/library.test.ts` — update the exact-shape assertion in `"search: response projects to documented public shape, omits internal columns"` (fixture default is `source_url: null`):

```ts
  expect(img).toEqual({
    id: "a1", prompt: "a fox", thumb_url: `${BASE}/assets/a1/thumb.webp`, medium_url: `${BASE}/assets/a1/medium.webp`,
    url: `${BASE}/assets/a1/image.webp`, width: 10, height: 20, mime: "image/webp",
    model_used: "flux", source: "pd12m", created_at: "2026-07-03 00:00:00", original_url: null,
  });
```

and add a new test after it:

```ts
it("search: sourced rows expose original_url", async () => {
  const s = fakeServices();
  (s as any)._libraryRows.push(libRow({ source_url: "https://pd12m.example/x.jpg" }));
  const res = await handleLibrarySearch(new URL("https://x/v1/library"), s, cfg);
  const j: any = await res.json();
  expect(j.images[0].original_url).toBe("https://pd12m.example/x.jpg");
  expect(j.images[0]).not.toHaveProperty("source_url");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `projects/worker`): `npm test -- test/handler.test.ts test/library.test.ts`
Expected: the two extended hit tests, the reshaped `toEqual`, and the new sourced-row test FAIL (`original_url` undefined); everything else passes.

- [ ] **Step 3: Implement**

`projects/worker/src/handler.ts` — in the match response, add `original_url` as a sibling of `sizes`:

```ts
      sizes: { thumb: u.thumb_url, medium: u.medium_url, large: u.url },
      original_url: u.original_url,
```

`projects/worker/src/library.ts` — update `publicAsset` and its comment:

```ts
// The documented public shape for a library image (spec §GET /v1/library).
// source_id and locally_cached stay internal; source_url is deliberately
// public as original_url (spec 2026-07-07-large-cap-original-url-design.md).
// The URL fields are derived (Task 10 / migration 0007).
function publicAsset(r: LibraryAssetRow, baseUrl: string | undefined) {
  const u = assetUrls(r, baseUrl);
  return {
    id: r.id, prompt: r.prompt, thumb_url: u.thumb_url, medium_url: u.medium_url,
    url: u.url, width: r.width, height: r.height, mime: r.mime,
    model_used: r.model_used, source: r.source, created_at: r.created_at,
    original_url: u.original_url,
  };
}
```

- [ ] **Step 4: Run the full worker suite**

Run (from `projects/worker`): `npm test`
Expected: PASS (all files — catches any other exact-shape assertion touched by the new field).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/handler.ts projects/worker/src/library.ts projects/worker/test/handler.test.ts projects/worker/test/library.test.ts
git commit -m "feat(worker): expose original_url in generate and library responses"
```

---

### Task 4: Playground "View original" links + API docs snippet

**Files:**
- Modify: `projects/worker/public/index.html` (4 spots: CSS ~line 1776, result-details markup ~line 3020, docs snippet ~line 3248, JS `libraryCard` ~line 4110 and result handler ~line 4372)

**Interfaces:**
- Consumes: `sc.original_url` (generate response) and `img.original_url` (library items) from Task 3.
- Produces: user-visible links only; nothing downstream.

No vitest coverage exists for `index.html`; this task is verified manually (Step 5).

- [ ] **Step 1: Add the CSS class**

Next to the `.result-details` styles (around line 1776), add:

```css
    .view-original-link { display: inline-block; margin-bottom: 12px; font-size: 0.8125rem; color: var(--muted); text-decoration: underline; }
    .view-original-link:hover { color: var(--ink); }
```

- [ ] **Step 2: Result view — markup + JS**

Markup: between the closing `</div>` of `details-grid` (line ~3020) and the provenance `<button …onclick="viewProvenance()">`, insert:

```html
              <a id="view-original" class="view-original-link" target="_blank" rel="noopener" hidden>View original ↗</a>
```

JS: in the generate result handler, directly after the line
`document.getElementById('val-latency').textContent = \`${latency}ms\`;` (~line 4372 — this spot runs for hit, approximate, and pending alike), insert:

```js
        const viewOriginal = document.getElementById('view-original');
        if (sc.original_url) {
          viewOriginal.href = sc.original_url;
          viewOriginal.hidden = false;
        } else {
          viewOriginal.hidden = true;
          viewOriginal.removeAttribute('href');
        }
```

- [ ] **Step 3: Library cards**

(The spec mentions a "library lightbox"; the playground has none — cards with a Download action are the library's only per-image surface, so the link goes there.)

In `libraryCard(img)` (~line 4110), add an "Original ↗" link after the Download anchor, reusing the existing `library-download` style and `escapeHtml` (already defined in this file):

```js
    function libraryCard(img) {
      const thumb = img.thumb_url || img.medium_url || img.url;
      const tags = [img.model_used, img.source].filter(Boolean)
        .map(t => '<span class="library-tag">' + escapeHtml(t) + '</span>').join('');
      const original = img.original_url
        ? '<a class="library-download" href="' + escapeHtml(img.original_url) + '" target="_blank" rel="noopener">Original ↗</a>'
        : '';
      return '<div class="library-card">' +
        '<img class="library-thumb" loading="lazy" src="' + escapeHtml(thumb) + '" alt="' + escapeHtml(img.prompt) + '">' +
        '<div class="library-meta">' +
          '<p class="library-prompt" title="' + escapeHtml(img.prompt) + '">' + escapeHtml(img.prompt) + '</p>' +
          '<div class="library-tags">' + tags + '</div>' +
          '<a class="library-download" href="/v1/library/' + encodeURIComponent(img.id) + '/download">Download</a>' + original +
        '</div></div>';
    }
```

- [ ] **Step 4: API docs snippet**

In the hit-response example (~line 3248), after the `"sizes"` line and before the closing `}` of `shared_cache`, add (note the trailing comma moves to the sizes line):

```html
    <span class="tk-key">"sizes"</span>: { <span class="tk-key">"thumb"</span>: <span class="tk-str">"…"</span>, <span class="tk-key">"medium"</span>: <span class="tk-str">"…"</span>, <span class="tk-key">"large"</span>: <span class="tk-str">"…"</span> },
    <span class="tk-key">"original_url"</span>: <span class="tk-str">"https://pd12m.s3.us-west-2.amazonaws.com/…"</span>
```

- [ ] **Step 5: Manual verification**

Follow the `running-locally` skill (`.claude/skills/running-locally`) to boot `wrangler dev --local` in `projects/worker` with the demo library seed, then:

1. Library view: cards for seeded (sourced) images show both "Download" and "Original ↗"; the Original link opens the source URL in a new tab. A generated/demo row without `source_url` shows Download only.
2. Matching view: run a prompt that matches a seeded image — the details panel shows "View original ↗" under the stats grid; a pending result (offline, generation 500s locally — expected per the skill) leaves the link hidden.
3. Docs view: the hit-response example shows `original_url`.

Expected: all three hold; no console errors from the new JS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(playground): View original link for sourced images"
```

---

### Final check

- [ ] Run both suites one last time from a clean state:

```bash
uv run pytest -q                      # repo root
cd projects/worker && npm test        # worker
```

Expected: PASS everywhere. Then the branch is ready for review (superpowers:requesting-code-review / finishing-a-development-branch).
