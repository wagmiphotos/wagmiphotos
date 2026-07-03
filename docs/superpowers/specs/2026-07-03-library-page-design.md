# Library page — design

**Date:** 2026-07-03
**Status:** Approved

## Purpose

Add a public "Library" page to the wagmi.photos site where anyone can keyword-search
the shared image library and download images. Today the only way to reach an image
is the semantic-match generations endpoint, which requires an API key and returns a
single best match.

## Scope

- New public worker endpoints: library search and image download.
- New `#/library` SPA view in `projects/worker/public/index.html` with a top-level
  "Library" nav link.
- Keyword search only. Semantic search (CLIP + Vectorize) is an explicit follow-up,
  not part of this build.
- No auth and no rate limiting on the new endpoints (images are public-domain PD12M;
  revisit if abused).

## Backend

### `GET /v1/library`

Public, GET only (other methods 404 like existing routes).

Query params:

| Param | Default | Notes |
|---|---|---|
| `q` | empty | Optional keyword query. Empty → browse mode (recent images). |
| `limit` | 24 | Numeric values are clamped to 1–60; non-numeric → 400. |
| `offset` | 0 | Non-numeric or negative → 400. |

Behavior:

- Empty `q`: recent assets ordered `created_at DESC, id DESC`.
- Non-empty `q`: case-insensitive `LIKE '%q%'` over `assets.prompt`, same ordering.
  User input is escaped so `%` and `_` match literally (`ESCAPE '\'`).
- Invalid `limit`/`offset` per the table above → `400` JSON error.

Response `200`:

```json
{
  "images": [
    {
      "id": "…", "prompt": "…",
      "thumb_url": "…", "medium_url": "…", "url": "…",
      "width": 1024, "height": 1024, "mime": "image/webp",
      "model_used": "…", "source": "…", "created_at": "…"
    }
  ],
  "has_more": true
}
```

`has_more` is computed by fetching `limit + 1` rows and trimming.

### `GET /v1/library/:id/download`

Public, GET only. Proxies the full-size image so downloads work regardless of the
asset host's CORS policy.

- Unknown id → `404` JSON error.
- Fetches `asset.url` server-side; non-OK upstream or fetch failure → `502` JSON error.
- Streams the upstream body with:
  - `Content-Type`: upstream header, falling back to `asset.mime`, then
    `application/octet-stream`.
  - `Content-Disposition: attachment; filename="<slug>.<ext>"` where `slug` is the
    prompt lowercased, non-alphanumerics collapsed to dashes, trimmed to 60 chars
    (falls back to the asset id), and `ext` derives from the mime type
    (`png`, `jpg`, `webp`, `gif`; default `bin`).

The upstream fetch is injected (same pattern as other services) so tests can fake it.

### Code changes

- `src/d1.ts`: add `searchAssets({ q, limit, offset })` to the assets store,
  returning rows including `created_at`.
- `src/types.ts`: extend `AssetStore` accordingly; add `created_at` to the returned
  row shape for library listings.
- New `src/library.ts`: `handleLibrarySearch` and `handleLibraryDownload`
  (keeps `handler.ts` focused on the generations flow).
- `src/index.ts`: route both paths before the `/v1/` catch-all 404.

## Frontend (`public/index.html`)

- Route table entry `'#/library': { view: 'view-library', link: 'nav-library' }`,
  loading the first page on show.
- Top-level "Library" nav link next to Pricing (inherits the mobile menu for free);
  also add a "Library" link to the footer list.
- View layout, styled with the existing black/red system:
  - Heading + one-line description.
  - Search input, debounced ~300 ms, Enter searches immediately. New search resets
    paging.
  - Responsive thumbnail grid (4 / 3 / 2 columns as width shrinks). Each card:
    thumbnail (`thumb_url` → `medium_url` → `url` fallback, `loading="lazy"`),
    two-line clamped prompt with full text in `title`, small model/source badges,
    and a Download button — a plain `<a href="/v1/library/:id/download">` so the
    browser handles the attachment.
  - "Load more" button appends the next offset; hidden when `has_more` is false.
  - States: loading spinner, empty ("No images match…"), error with retry button.

## Testing

Extend the existing vitest suites:

- `test/d1.test.ts`: `searchAssets` — browse mode ordering, case-insensitive match,
  literal `%`/`_` matching, limit/offset behavior.
- `test/router.test.ts`: `GET /v1/library` response shape, 400 on bad params,
  non-GET 404; download route 404 on unknown id.
- Handler tests: download proxy headers (attachment filename, content type),
  upstream failure → 502; filename slug/extension derivation.

## Out of scope / follow-ups

- Semantic search toggle on the library page.
- Rate limiting or auth for library endpoints.
- Admin actions (delete, re-caption, re-generate).
