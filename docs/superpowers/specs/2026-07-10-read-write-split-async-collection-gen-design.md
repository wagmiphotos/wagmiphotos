# Read/write API split + async collection generation + Library/Collections page merge

Date: 2026-07-10
Status: approved design (brainstormed with Joris)
Supersedes: the sync BYOK generation path inside `/v1/images/generations`
(spec 2026-07-09-byok-self-serve-generation-design.md remains the reference for
key storage, moderation, reserve/refund, and estimates — only the *transport*
changes here).
Context: docs/HANDOFF-2026-07-10-async-byok-gen.md (why gpt-image-2 cannot
survive a synchronous request).

## Problem

`POST /v1/images/generations` conflates a ~100ms cache lookup with a 13–80s
paid generation in one request. Every failure of the past week (OpenAI's ~20s
idle-kill, billed-but-undelivered generations, the SSE streaming workaround,
the staged loader masking a hanging request) traces back to that conflation.
Separately, the SPA splits search across two overlapping pages (playground,
library) while collection management hides in the account page.

## Decisions (locked with user)

1. **Read/write split.** The existing URL becomes a pure closest-match lookup
   with no generation and no tuning knobs. Creation moves to a new async,
   BYOK-gated, collection-scoped endpoint.
2. **Creation requires an owned collection.** Users can only create images
   inside collections they own. The shared library grows **only** through the
   operator's demand-ranked, moderated backfill — no user-facing path writes to
   it anymore. (No bootstrap deadlock: the first collection slot is free,
   `requiredGenerationsFor(1) = 0`.)
3. **Both auth modes on the creation endpoint** (session and bearer), ownership
   still enforced — agents can build their own themed collections.
4. **Miss contract: serve approximate.** With the tolerance knob gone, the read
   endpoint pins tolerance at the server default and always returns the closest
   match with `result: hit|approximate` + similarity score. Callers threshold
   client-side. Demand queued below floor (unscoped only); `202 pending` only
   on an empty pool.
5. **Always `202` on creation** — even a 13s gpt-image-1 job returns a ticket
   and gets polled. One contract, one code path.
6. **SPA: one page, two tabs** (Library | Collections). BYOK provider-key
   management moves into the Collections tab (the only place it is used);
   bearer API keys and billing stay on the Account page.

## 1. API surface

### `POST /v1/images/generations` (read — URL unchanged, simplified)

- Body: `{prompt, n?, size?, collection?}`.
- `cache_tolerance` and `generate_on_miss` are **removed outright** — no
  deprecation shim, the product is pre-launch (unknown JSON fields are simply
  ignored, as standard).
- `collection` remains for scoped *search*; collections stay publicly readable.
- All BYOK plumbing (`runByok`, `generatedResponse`, byok fallback statuses)
  leaves `handler.ts`.

### `POST /v1/collections/:id/generations` (create — new)

- Body: `{prompt, size?}` (no `n` — one image per job; no model/quality knobs,
  the provider pin decides, consistent with the no-model-param API philosophy).
- Auth: session or bearer. Gates in order: 401 unauthenticated → 404 unknown
  collection → 403 not owner → BYOK not configured / cap reached (reuse the
  existing status codes from the sync path) → 400 `content_policy` (prompt
  moderation, fail-closed) → atomic quota reserve → provider submit →
  D1 job row → **`202 {generation_id, status, estimate}`**.
- Prompt composed with the collection theme exactly as today
  (`combinedPrompt`), same MAX_PROMPT_LEN rule.

### `GET /v1/generations/:id` (poll — new, owner-only)

- `{status: queued|generating|succeeded|failed, image?: {url, sizes…},
  error?, byok: {used, cap, est_spend_usd}}`.
- Terminal failure refunds the reservation (existing seams in `src/byok.ts`).

## 2. Provider layer — the actual gpt-image-2 fix

Making *our* endpoint async is not sufficient: the billed-undelivered failures
are OpenAI's gateway idle-killing the **provider-side** connection. Both layers
must be async. Per-provider job driver:

- **GMI**: already an async queue. Split `makeGmiProvider` into explicit
  `submit → poll → download` steps (no connection lives >2s — the proven
  backfill pattern).
- **OpenAI**: **verify live** whether the Responses API background mode
  (`background: true` + `image_generation` tool) supports gpt-image-2. This is
  a research step in the plan, not an assumption.
  - If yes: submit, store the response id, poll like GMI; re-pin
    openai → gpt-image-2 medium @ $0.055 (commit c543a50 is the file template;
    revert a01f338 lists everything that moves together).
  - If no: OpenAI stays pinned to gpt-image-1 medium @ $0.04, executed as a
    single 13–20s call inside `ctx.waitUntil` at POST time (ducks the kill
    window); the ticket GET just reads D1.
- **Job driving**: client polls are the primary driver ("poll-through") — each
  `GET /v1/generations/:id` on a pending job performs a short provider status
  check, and on completion does download → webp@85 → R2 → D1 insert →
  Vectorize upsert (namespaced) → mark `succeeded`. A claim/attempts column
  prevents concurrent polls double-publishing (same pattern as migration 0006).
  Deliberately avoids betting on `waitUntil` wall-clock limits for 44–80s jobs.
- **Cron sweep**: new `scheduled` handler (the worker has none today) re-drives
  or fails-and-refunds jobs nobody polled to completion, and catches orphaned
  provider jobs.

## 3. Data model

Migration 0016: `generations` table — `id`, `user_id`, `collection_id`,
`prompt`, `provider`, `provider_job_id`, `status`
(`queued|generating|succeeded|failed`), `asset_id`, `error`, `claimed_at`,
`attempts`, `month` (for the refund), `created_at`, `updated_at`.
Index `(status, updated_at)` for the sweep. `collection_id` deliberately
carries no FK to `collections(id)` — generation rows are billing/audit
history and must survive collection deletion, so `DELETE FROM collections`
never has to touch (or be blocked by) them.

## 4. SPA — one page, two tabs

- Keep `#/library` as the canonical URL; `#/playground` redirects to it.
- **Library tab**: search box + grid (playground search UI merged into the
  library grid). "Create a fresh image" and "Match strictness" controls are
  deleted.
- **Collections tab** (login-gated):
  - BYOK provider-key setup/status, monthly cap, and estimate disclaimers
    (moved from account/playground) — key setup appears where the need arises.
  - Collections list with slot progress (moved from the account card), create
    collection.
  - Open a collection → its image grid + generate box: prompt → estimate →
    `202` → existing staged loader polls the ticket → image swaps in on
    success; terminal failure shows the error and the refunded state.
- **Account page** keeps: profile, bearer API keys, billing/Stripe, ToS.
- Docs page: remove `cache_tolerance`/`generate_on_miss` from examples (add a
  deprecation note), document the two new endpoints, include the `extra_body`
  collection snippet (handoff follow-up). Home hero CTA points at the merged
  page.

## 5. Deletions

- `runByok` and all BYOK branches out of the read handler; `GenBody` drops
  `cache_tolerance`/`generate_on_miss` entirely (validation included).
- The SSE-streaming workaround in `src/providers.ts` once nothing references
  it (gpt-image-1 ducks the kill window without partials).
- Playground page generation controls; account-card BYOK/slots UI.

## 6. Error handling summary

- Moderation unavailable → fail closed, no reserve, job never created.
- Reserve fails → `cap_reached` before any provider call.
- Provider submit fails → refund, job row marked `failed` (or not created).
- Poll finds provider job failed/expired → refund once (guarded by status
  transition), `failed` + error surfaced.
- Publish step failure after provider success → job stays claimable; sweep
  retries publish (provider artifact is re-downloadable via job id); refund
  only if the artifact is truly unrecoverable.
- Client never polls → sweep completes or fails+refunds the job.

## 7. Testing

- **Real-schema smoke tests**: at least one INSERT against a migrated local D1
  for the `generations` table and the publish path (the fake-D1 tests are how
  the 0007 `url`-column bug shipped — regression test already pins that
  schema; extend the discipline to the new table).
- Fixture tests for provider poll payloads (GMI job states; OpenAI background
  response states if adopted).
- Contract tests: approximate always carries `similarity`; creation gates
  return the documented statuses in order.
- Live browser smoke with a real key at the end (also still owed from the
  collections ship).

## 8. Rollout

1. Migration 0016 local → remote.
2. Worker deploy with both endpoints live (breaking change to the read
   endpoint params is fine — pre-launch).
3. SPA merge + docs update in the same deploy (the SPA is worker-served).
4. Re-pin gpt-image-2 only after the background-mode research step and a live
   end-to-end generation on prod.
5. Follow-ups unchanged from the handoff: OpenAI refund ticket (user action),
   R2 `byok/` orphans, floor re-probe at 11k.
