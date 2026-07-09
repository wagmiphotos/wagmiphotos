# Homepage Compare-Move + Tabless API Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing "Faster. Cheaper. Better." section below "What you get back", and rework the OpenAI-compatible section into two static stacked code cards (no tabs, no height jump, no squiggle) with the floating callout showing the real response JSON.

**Architecture:** Single-file edit to `projects/worker/public/index.html` (vanilla-JS SPA). One section block relocation + one section rewrite + CSS/JS dead-code removal.

**Tech Stack:** HTML/CSS in the SPA; verification via vitest/tsc (unchanged), a script-parse check, and a local `wrangler dev` + Playwright eyeball.

**Spec:** `docs/superpowers/specs/2026-07-09-homepage-compare-move-api-cards-design.md`

## Global Constraints

- HTML-only change: worker suite (255) and `tsc --noEmit` must be byte-for-byte unaffected.
- Match existing styling; no new JS; nothing interactive remains in the section.
- Final section order: hero → `#closest-match` → `#why-it-wins` → `#how-it-works` → manifesto → `#safety` → `#the-api` → Pricing → CTA → FAQ.
- Callout JSON must exactly mirror the old Response-tab body (url + result/similarity/source/model_used/cost_saved_usd with the same token spans).

---

### Task 1: All edits + verification

**Files:**
- Modify: `projects/worker/public/index.html`

- [ ] **Step 1: Move `#why-it-wins`.** Cut the block from `      <!-- Features -->` through the `</section>` immediately preceding `      <!-- Safety -->` (lines ~2675-2724) and insert it immediately after the `</section>` that closes `#closest-match` (before the comment/section that opens `#how-it-works`). Use a python script over exact string anchors; abort if any anchor count ≠ 1.

- [ ] **Step 2: Rework the `#the-api` code column.** Replace the single `.code-panel` (tab buttons + three pres + scribble) with two stacked panels — panel 1: tabbar dots + `<span class="code-tab active">OpenAI SDK</span>` + the existing python pre (drop `data-lang`); panel 2: dots + `<span class="code-tab active">API</span>` + the existing curl pre (drop `data-lang`/`hidden`). Delete the response pre and the `.code-scribble` svg. Replace the `.cache-callout` pre body with the full response JSON from the old Response tab (same `tk-*` spans, url line included).

- [ ] **Step 3: CSS.** Add `.code-wrap .code-panel + .code-panel { margin-top: 16px; }`. Remove from `.code-tab`: `cursor: pointer;`, the `transition`, and the `.code-tab:hover` rule (labels are static spans now). Remove the two `.code-scribble` rules and the now-unused `.code-body pre[hidden]` rule. If the callout's new url line overflows, constrain with `overflow-x: auto` on the callout pre (do not widen the card beyond its current max-width).

- [ ] **Step 4: JS.** Delete the `showCodeTab` function and its `// API section: request-example language tabs` comment. Confirm zero remaining references: `grep -c showCodeTab` → 0.

- [ ] **Step 5: Verify.** `cd projects/worker && npx vitest run && npx tsc --noEmit` (unchanged); node script-parse of the SPA `<script>` block; grep anchors (`why-it-wins` appears before `how-it-works`; `code-scribble`/`showCodeTab`/`data-lang="response"` gone). Then `npx wrangler dev --local` + Playwright: screenshot `#why-it-wins` position and `#the-api` to eyeball the two cards + callout.

- [ ] **Step 6: Commit** `feat(home): move compare section up; tabless API cards + truthful response callout`.
