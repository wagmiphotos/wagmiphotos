# UI polish batch — design

**Date:** 2026-07-09
**Status:** approved (brainstorm w/ Joris)
**Scope:** `projects/worker/public/index.html` only — no worker/API changes, no migrations.

## Items

### 1. ToS-modal "Log out" button styling

`.btn-ghost` defines only colors; it lacks the box metrics of its sibling
`.btn-solid.red`, so the ToS gate renders a bare bordered box next to the
styled red "I agree". Fix: add `.btn-ghost` to the shared metrics selector
(`.btn-solid, .btn-outline` block: inline-flex, display font, weight 700,
padding 13px 26px, radius 12px, cursor pointer). Side effect (accepted,
verify visually): the create-key modal's Cancel (`btn btn-ghost`) picks up
the same uniform modal-button sizing.

### 2. GitHub star badge

Root cause: the repo is private → public API 404 → worker correctly serves
`{"stars": null}` → badge shows "—". Decision: **hide the badge when stars
is not a number** (hide the whole badge anchor), show it with the formatted
count otherwise. No worker change. When the repo goes public (GitHub
settings — user's call, out of scope), the badge self-restores.

### 3. Form-control styling (BYOK + collections cards)

New `.field-input` CSS class: identical to `.api-key-input` (paper
background, 1px `var(--line)` border, 10px radius, 10px/14px padding, red
focus ring) minus the mono font. Apply to: BYOK provider `<select>`, BYOK
monthly-cap input, collections name input, collections theme textarea. The
BYOK api-key input uses the existing `api-key-input` class as-is (it wants
the mono font). Remove the now-redundant inline `height:40px` styles where
the class supersedes them.

### 4. Playground: reorder + tolerance gating

- The "on cache miss" form-group moves ABOVE the tolerance form-group.
- The checkbox gates the tolerance block: unchecked → tolerance form-group
  visually disabled (opacity ~0.45, slider `disabled`) and the request
  OMITS `cache_tolerance` (server default 0.15 applies); checked →
  configurable exactly as today.
- Toggle handler updates the disabled state live.

### 5. Friendlier wording (playground)

- Section label "On cache miss" → **"When there's no close match"**.
- Checkbox lead "Generate on demand." → **"Create a fresh image."**;
  sub-copy: "If the library has nothing close enough, a new image is made
  for your prompt and added to the library."
- Tolerance label "Cache match tolerance" → **"Match strictness"**; slider
  header ends "Exact match" / "Loose match". The numeric "Tolerance: N"
  info line stays (it is the documented API value).

### 6. Generation-key indicator (playground)

A status line inside the "when there's no close match" group, visible only
while the checkbox is checked, rendered from the existing `currentByok`
global (populated by `/v1/me`; updated by BYOK save/patch/delete):

- Enabled key: `✓ Uses your <Provider> key ••••<last4> — <used>/<cap>
  images this month · Manage` (link `#/account`).
- Key present but disabled: `⚠ Your <Provider> key is disabled — fix it in
  Account` (link `#/account`).
- No key: `No provider key set — your prompt joins the shared generation
  queue instead (can take a while). Add your key →` (link `#/account`).

Re-renders on playground `onShow` and on checkbox toggle. Provider names
and last4 come from the server (`currentByok.provider`, `key_last4`);
last4 is escaped like all interpolated content.

## Error handling

All new rendering is defensive: missing elements no-op (file convention);
`currentByok` null renders the no-key state; a failed `/v1/meta/stars`
fetch leaves the badge hidden (current code already catches).

## Testing

No SPA unit tests exist. Verification: router tests (SPA shell serves),
script-parse (`new Function` extraction), full `npx vitest run` +
`npx tsc --noEmit`, then a local `wrangler dev` visual pass of: ToS modal
buttons, hidden star badge, BYOK + collections forms, playground order/
gating/indicator in all three key states. Deploy = `npm run deploy` only.
