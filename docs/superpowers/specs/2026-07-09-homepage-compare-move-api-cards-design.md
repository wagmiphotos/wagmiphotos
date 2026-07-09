# Homepage: compare-section move + tabless API cards — design (2026-07-09)

All changes in `projects/worker/public/index.html` (the SPA homepage). No API
or worker-logic changes.

## 1. Move "Faster. Cheaper. Better."

Move the whole `#why-it-wins` section (the compare grid, currently after the
manifesto band) to directly after `#closest-match` ("What you get back") and
before `#how-it-works`. Pure relocation — no content, CSS, or copy changes.
Resulting order: hero → What you get back → **Faster. Cheaper. Better.** →
How it works → manifesto → Safety → OpenAI compatible → Pricing → CTA → FAQ.

## 2. OpenAI-compatible section: two cards, no tabs

Today: one code panel with three JS-swapped tabs (OpenAI SDK / cURL /
Response) whose differing line counts make the section height jump, a red
`code-scribble` SVG decoration, and a floating "Cache hit · 41 ms · $0.055
saved" callout showing a trimmed 3-field JSON that doesn't match the Response
tab.

Target:

- **Two stacked code panels** in the existing right-hand column: "OpenAI SDK"
  (the Python example) on top, "API" (the cURL example) below. Each keeps the
  mac-dots header bar with a static label (same styling as the active tab)
  instead of buttons. Static content → constant height.
- **Delete** the `showCodeTab()` JS function, the three `.code-tab` buttons,
  the now-unused `.code-tab` CSS rules, the `hidden` attributes on the pres,
  and the `code-scribble` SVG + its CSS (the red squiggle).
- **The floating callout becomes the actual response**: keep the
  "✓ Cache hit · 41 ms · $0.055 saved" head; the body shows the full response
  JSON from the old Response tab — `data[0].url` + `shared_cache`
  (`result: "hit"`, `similarity: 0.9312`, `source: "pd12m"`,
  `model_used: "flux-schnell"`, `cost_saved_usd: 0.055`) — so the card's
  content is exactly what the API returns and agrees with the header numbers.
  The Response tab itself is removed (its content lives in the callout).
- Callout keeps its current overlap position (bottom-right of the code
  column, over the lower panel). Mobile stacking behavior unchanged.

## Constraints

- Match existing homepage styling (glass panels, tabbar dots, tokens like
  `tk-key`/`tk-str`); no new design language, no new JS.
- The section must not shift height on any interaction (nothing interactive
  remains).
- Verification: suite + `tsc --noEmit` unchanged (HTML-only), SPA script block
  still parses, and a browser eyeball of the three states (desktop order,
  section heights, callout content) via local `wrangler dev`.
