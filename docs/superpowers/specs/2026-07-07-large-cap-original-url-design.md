# Cap rehosted `large` at 2048px + expose `original_url`

**Date:** 2026-07-07
**Status:** Approved

## Motivation

The rehost pipeline re-encodes the `large` variant at the source image's
original resolution (WebP q90, no downscale). For the current ~1k seed pool
that is tolerable; for a big PD12M seed it is the dominant storage term —
roughly 5–12 TB for the full 12M corpus, versus ~2–3 TB with a 2048px cap.
Capping loses nothing users care about because the original stays reachable:
we expose the pd12m source URL in API responses and the playground, so anyone
who wants the full-resolution original can open it directly.

## Decisions

- Cap the `large` variant at **2048px longest side** (never upscale).
- Expose the source URL as a **top-level `original_url` field**, not a fourth
  entry in `sizes` — `sizes` means "our derived B2 WebP variants"; the
  original is an external, differently-formatted resource.
- Surface it in the match/generate response, library items, **and** a
  playground "View original" link.
- The cap lives inside `derive_sizes` so every caller inherits the invariant.
  Generated images are 1024px, so the generation path is unchanged in
  practice.

## Design

### 1. Python — cap in `derive_sizes`

`projects/generation/src/wagmiphotos/generation/processor.py`:

- Add module constant `MAX_LARGE_DIM = 2048`.
- Signature becomes `derive_sizes(image_bytes, max_dim=MAX_LARGE_DIM)`;
  apply `img.thumbnail((max_dim, max_dim))` to the large variant before the
  q90 WebP encode — the same pattern medium/thumb already use. PIL
  `thumbnail` never upscales, so sources ≤2048px keep their dimensions.
- `width`/`height` in D1 keep coming from `dimensions(sizes["large"])`; they
  now describe the capped large — the dimensions of what we serve. The true
  original is linked separately via `original_url`.
- The constant is Python-only. No `contract.json` pin: the Worker never
  consumes the cap, and the contract pins cross-language constants only.

### 2. Worker — `original_url` derivation

`projects/worker/src/asset-urls.ts`:

- `assetUrls()` returns an additional `original_url: a.source_url ?? null`.
- Populated whenever the row has a source URL, regardless of
  `locally_cached`:
  - pre-rehost sourced row → `original_url === url` (both the pd12m link)
  - post-rehost sourced row → B2 `url` + pd12m `original_url`
  - generated asset → `null`

### 3. Worker — API surface

- `handler.ts`: match/generate response gains top-level `original_url`
  next to `sizes`.
- `library.ts`: library items gain the same field. Update the comment at
  library.ts:10 — `source_id` and `locally_cached` stay internal;
  `source_url` is now deliberately public as `original_url`.
- Update the API-reference snippet in the playground docs
  (`public/index.html`, response-shape example) to show the new field.

### 4. Playground UI

`projects/worker/public/index.html`: wherever a full-size image is shown
(match result view, library lightbox), render a "View original ↗" link
(`target="_blank" rel="noopener"`) only when `original_url` is non-null.
Styled as a quiet secondary link per the light black/red theme, never a
primary button.

### 5. Migration / compatibility

None needed.

- Already-rehosted full-res rows stay as they are — bigger files, correctness
  unaffected.
- `original_url` is additive; existing API clients are unaffected.
- The current pool rehosts under the new cap from the next backfill run
  onward.

### 6. Error handling

No new failure modes. `original_url` is null-safe end to end; the cap uses
the same code path medium/thumb already exercise. The existing
`ASSET_BASE_URL`-unset degrade path in `assetUrls` is untouched.

### 7. Testing

- **Python** (`projects/generation/tests`): a >2048px source caps to 2048
  longest-side; a ≤2048px source keeps its dimensions; aspect ratio
  preserved.
- **Worker** (`projects/worker/test`): `assetUrls` returns `original_url`
  for sourced rows (cached and uncached) and `null` without a source;
  `handler.test.ts` / `library.test.ts` assert the field in both response
  shapes.

## Out of scope

- Demand-ranked rehost ordering (discussed separately; own spec when picked
  up).
- Tombstoning assets whose source 404s permanently.
- Re-deriving already-rehosted full-res rows.
