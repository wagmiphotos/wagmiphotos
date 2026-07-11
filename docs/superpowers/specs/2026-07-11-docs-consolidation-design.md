# Docs consolidation — merge #/openai into #/docs

**Date:** 2026-07-11
**Status:** Approved (approach A — single-flow quickstart, cut hard, one nav entry)

## Problem

The site has two developer pages: `#/openai` ("A drop-in for the OpenAI Images API" — short,
liked) and `#/docs` ("API reference" — ~250 lines, too much text). Joris wants one page that is
very simple and easy to read.

## Decisions

- **One page** at `#/docs`; the `view-openai` div is deleted.
- **Cut hard:** quickstart style; long prose is dropped or reduced to one-liners that link out.
- **One nav entry:** the Developers dropdown shows "Docs" instead of "API reference" +
  "OpenAI drop-in". Semantic matching and Agents entries are untouched.
- `#/openai` keeps working (routes to the merged view); the `/openai` path alias points at
  `#/docs`. All existing in-page anchor ids are preserved.

## Page structure (top to bottom)

1. **Head** — eyebrow "Developers"; title "A drop-in for the OpenAI Images API"; the current
   openai page's one-line sub (base-URL swap + `shared_cache` rides along).
2. **The only change** — before/after `base_url` compare cards + "swap your key (`sc-…`)" line.
3. **Call it** — ONE code block with real tabs: Python | JavaScript | cURL. Content = the three
   existing snippets. Tabs are new (~10 lines JS + small CSS on the existing `.code-tab` look);
   the existing auto-injected Copy buttons (`#view-docs .docs-pre`) must keep working.
   Carries anchor id `docs-generations` + endpoint badge `POST /v1/images/generations`.
4. **What you get back** — annotated 200 response JSON (existing block, incl. `original_url`
   note as a trailing comment line or one sentence), then a compact 3-row result table:
   - `hit` / 200 — at or above the match floor; served, nothing queued.
   - `approximate` / 200 — best image below the floor; served anyway, prompt queued,
     `cost_saved_usd` is 0.
   - `pending` / 202 — nothing to serve; `data` empty, prompt queued, retry later.
   Below the table, two one-liners (keeping their anchor ids):
   - `docs-matching`: "Matching is prompt-to-prompt BGE cosine similarity against a fixed
     server-side floor (≈0.85) — see [how semantic matching works](#/matching)."
   - `docs-backfill`: "Every miss records demand; the most-requested prompts are built by the
     shared backfill and become hits for everyone. `generation_queued` tells you if yours is
     queued."
5. **What stays the same, what you gain** — the two existing summary cards, unchanged.
6. **Reference strip** (tight sections, existing table styles):
   - **Request fields** — same 5 rows (prompt, collection, n, size,
     model); `collection` description cut to ~2 sentences + link down to the collections
     section; keep the "no `cache_tolerance` / `generate_on_miss`" fact as a table footnote or
     inside the prompt row's description.
   - **Create images in your collections** (`docs-collection-generations`) — intro sentence
     (always spends; deliberate async escape hatch vs. demand-ranked backfill), endpoint badge
     `POST /v1/collections/:id/generations` (202 + ticket), endpoint badge
     `GET /v1/generations/:id` (poll until terminal), then three one-liners: statuses
     (`queued → generating → succeeded|failed`), failed = auto-refunded against the monthly
     cap, not-your-collection / unknown id = 404. The two short curl examples survive as one
     combined block (start + poll) — they are short and load-bearing.
   - **Auth & keys** (`docs-auth`) — three lines: magic-link login → create key on Account →
     send `Authorization: Bearer sc-…`; keys hashed, shown once, minting rate-limited; "Prefer
     the API? `POST /v1/keys/generate` works with a logged-in session cookie." The long
     key-minting curl example is cut.
   - **Errors** (`docs-errors`) — same 5-row status table, wording tightened.
   - **Health** (`docs-health`) — endpoint badge + one line.

## What is deleted

- The whole `view-openai` div (its content moves or already exists in the merged page).
- Docs: the key-minting curl block, the standalone "Example" curl (now a tab), the separate
  collection-scoped Python example (folded into the Python tab as the existing 2-line comment),
  the long "How matching works" and "Background generation semantics" paragraphs (→ one-liners),
  the 202 response JSON block (→ `pending` row), duplicated "want a fresh image now" notes
  (one stays, as the intro to the collections section).

## Nav / routing / cleanup

- Developers dropdown: one entry `#/docs`, id `nav-docs`, title "Docs", sub like
  "Swap the base URL — that's the API." Remove the `nav-openai` entry.
- `ROUTES`: `'#/openai'` → `{ view: 'view-docs', link: 'nav-docs' }` (old links land on the
  merged page); `PATH_TO_HASH`: `'/openai': '#/docs'`.
- Footer: single "Docs" link replaces "API reference" + "OpenAI drop-in".
- In-content links to `#/openai` or `#/docs` elsewhere on the site: retarget to `#/docs`
  (check: home `#the-api` section, agents page, matching page, response-note box).

## Verification (Playwright, local static serve)

- 360 / 520 / 1280 px: merged page renders, no horizontal overflow.
- Tabs switch between Python/JS/cURL; Copy button copies the visible tab's code.
- `#/openai` shows the merged page; footer + dropdown links work.
- From `#/matching`, the `#docs-matching` link scrolls to the matching one-liner.
- No console errors; no leftover references to `view-openai` in HTML/JS.
