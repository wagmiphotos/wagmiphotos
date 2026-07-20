# Homepage stats + showcase section

**Date:** 2026-07-21
**Status:** approved by Joris (design review in session)

## Goal

Add a social-proof section to the wagmi.photos landing page: a live library
count ("511,501 images and counting") plus a strip of good-looking preview
images, placed directly after the hero.

## Decisions made (with Joris)

1. **Live count from the API** — not a static "500,000+" claim, and NOT
   "12+ million" (prod holds 511,501 live assets as of 2026-07-21; inflated
   claims are off the table).
2. **Showcase = top-liked images, operator-seeded** — Joris likes his
   favourite images in the browser to bootstrap it; over time community likes
   take over. Fits the "shaped by everyone" brand. No hand-maintained ID list.
3. **Placement** — new section immediately after the hero, before
   `#closest-match`.
4. **Transport** — one new cached endpoint (Approach A), daily edge cache.

## Endpoint: `GET /v1/home`

Public, no auth, **not** behind any rate limiter (edge cache absorbs traffic).

```json
{
  "image_count": 511501,
  "showcase": [
    { "id": "...", "thumb_url": "...", "medium_url": "...", "prompt": "...", "like_count": 3 }
  ]
}
```

- `image_count`: `SELECT COUNT(*) FROM live_assets WHERE collection_id IS NULL`
  (tombstone-aware view, and collection assets are excluded — parity with the
  rule that unscoped browse never surfaces collection assets).
- `showcase`: up to 8 rows, **restricted to `locally_cached = 1 AND collection_id IS NULL`** so tiles
  always serve fast B2 thumbs, never hotlinked full-size originals
  (only ~1k of 511.5k assets are rehosted today; the bulk sweep is a separate
  workstream). Ordering: `like_count DESC`, then newest, filtered to cached
  rows. With zero liked-and-cached images (today's state) it degrades to
  newest-cached — the section still renders.
- URLs derived via the existing `assetUrls()` helper (`asset-urls.ts`) —
  no new URL logic.
- Caveat (accepted): an image liked before it is rehosted won't appear until
  the sweep catches it. Self-healing.

### Caching

`Cache-Control: public, max-age=86400` on the response, plus an explicit
`caches.default` match/put in `index.ts` keyed on an internal URL — the same
idiom as `/v1/meta/stars` (Workers do not auto-edge-cache handler responses;
`stale-while-revalidate` is ignored by the Workers Cache API, so it is not
used). Consequences (accepted): D1 sees roughly one query per colo per day;
newly liked images take up to a day to show on the homepage.

## UI: `<section id="library-live">`

Inserted in `projects/worker/public/index.html` between the hero section and
`#closest-match`, styled with the existing landing-page vocabulary
(`.section`, `.section-title`, red/black accents).

- **Count headline**: "511,501 images and counting" — number formatted with
  `toLocaleString()`, count-up animation on scroll-into-view, guarded by
  `prefers-reduced-motion` (reduced = static final number, no animation).
- **Image strip**: 8 thumbnails, `loading="lazy"`, fixed aspect-ratio boxes
  (no layout shift), alt text from prompt. Clicking goes to `#/library`
  (deep-linking into the image-detail modal is a possible later enhancement,
  out of scope here).
- **CTA**: "Browse the library →" linking to `#/library`.
- **Failure fallback**: if the `/v1/home` fetch fails (network error, timeout,
  or non-2xx), the headline renders static "500,000+ openly licensed images"
  and the strip stays hidden. On success with an empty showcase, the live
  count still animates in independently — only the strip stays hidden. The
  landing page never breaks or shows spinners for this section.

The SPA fetches `/v1/home` same-origin once when the landing view renders —
no CORS changes.

## Testing

- Vitest route test (existing D1 test harness) for `/v1/home`:
  - response shape (`image_count`, `showcase` array),
  - showcase contains only `locally_cached = 1` assets,
  - like-ordering with newest-cached fallback,
  - tombstoned assets excluded from the count,
  - `Cache-Control` header present with `max-age=86400`.
- SPA behaviour verified manually (no DOM test harness exists; jsdom can't
  exercise image loading or scroll animation meaningfully).

## Out of scope / follow-ups

- **Bulk rehost sweep** of the ~510,498 un-rehosted assets — the real fix for
  slow library-grid loads (grid falls back to full-size external originals
  when `thumb_url` is null). Planned as its own workstream immediately after
  this ships; Joris confirmed wanting it.
- Deep-linking homepage tiles into the library image-detail modal.
- Any change to generation knobs, sort params, or the API surface beyond
  `/v1/home` (see product guardrails — `sort`/likes are browse-only).
