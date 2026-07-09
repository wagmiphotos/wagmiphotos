# Handoff 2026-07-10 — async BYOK generation (next task) + session state

## Where things stand (all LIVE in prod, worker version ae165dc2, main pushed at a01f338+)

Shipped across 2026-07-09/10, in order:

- **Collections** (spec/plan `docs/superpowers/*/2026-07-09-collections*`): themed,
  BYOK-gated image groups; `collection` param on `/v1/images/generations` + `/v1/library`;
  namespaced Vectorize index `wagmiphotos-coll`; serve counts; backfill exclusion =
  scoped requests never write `queries`. Migration 0015 applied remote.
- **Progressive slots**: nth collection needs 10^(n-1) lifetime generations
  (`byok_usage` sum); `slots` object on the list endpoint; account-card progress hint.
- **UI polish**: ToS button metrics, star badge hidden while the repo is private,
  `.field-input` form styling everywhere (incl. all selects), playground reorder
  ("Create a fresh image" gates "Match strictness"; omitted tolerance = server default),
  key-status indicator, estimate disclaimers + provider dashboard links, staged loader
  with elapsed counter.
- **Library seeded to 11,005 images** (10k PD12M rows via local parquet
  `~/data/PD12M/metadata`; HF path broken — `HF_TOKEN` in `deploy/gmi/.env` is invalid
  and `jorissup/PD12M-bucket` is private).
- **BYOK generation WORKS end-to-end** (two user-generated images live). Final config:
  openai → **gpt-image-1 medium @ $0.04**, webp@85, **SSE streaming**
  (`stream: true, partial_images: 1`, CRLF-safe parser in `src/providers.ts`),
  300s timeout. Fixed along the way: `insertGenerated` wrote the 0007-dropped `url`
  column (every prod BYOK insert had EVER failed — regression test now pins the
  schema); api_key trim on save; quality pinned (auto was billing ~$0.17 vs the
  advertised $0.04).

## THE NEXT TASK: async BYOK generation (bring gpt-image-2 back)

**Why:** OpenAI's gateway intermittently kills silent/long image connections after
~20s — **billed but undelivered** (user has ~$1.50 of these; refundable via OpenAI
support ticket, still to be filed). gpt-image-1 medium (13–20s) ducks under the
window; **gpt-image-2 medium (44–80s) cannot survive it even with streaming**
(tried c543a50, reverted a01f338 after repeated live failures — the partial→completed
SSE gap is still 30–60s of silence). Community consensus (see research refs below):
long generations need an async pattern.

**The proof it works: our own GMI adapter and backfill.** GMI's API is an async job
queue (submit → poll → download; `makeGmiProvider` in `src/providers.ts`) — no
connection lives >2s, so nothing gets idle-killed. The backfill generates gpt-image-2
(via GMI) reliably for exactly this reason.

**Design sketch to evaluate (not yet spec'd — brainstorm first):**
1. Scoped/BYOK generation request that will exceed ~20s → worker returns `202`
   with a ticket (e.g. `generation_id`), enqueues the job.
2. Executor options to compare:
   a. **Reuse the demand queue + backfill box** (new lane: user-keyed jobs — needs
      key decryption OFF the box or a worker-side generate endpoint the box calls;
      careful: BYOK_KEK must not leave the worker).
   b. **Worker-side async**: Cloudflare Queues consumer or a cron/DO that runs the
      same `tryByokGenerate` outside the user request (KEK stays in the worker —
      likely the right shape).
   c. OpenAI Responses API background mode (server-side async at OpenAI) — check
      current API support for image tools + webhooks before building anything.
3. SPA: staged loader already exists; extend to poll the ticket (`/v1/generations/:id`
   or piggyback on `/v1/library` search-by-id) and swap in the image on completion.
4. Billing/quota: reserve stays atomic at enqueue; refund on terminal failure —
   the reserve/refund seams in `src/byok.ts` already model this.
5. Then re-pin openai → gpt-image-2 medium @ 0.055 (the c543a50 diff is the exact
   template; revert commit a01f338 shows every file that must move together).

**Testing notes for whoever builds it:** the fake-D1 SQL tests validate nothing about
real schemas (that's how the `url` bug shipped) — add at least one smoke INSERT against
a migrated local D1. Live SSE/format fixtures: captured streams from 2026-07-09 showed
`event:`/`data:` blocks with `type`, `b64_json`, `output_format`; completed is last.

## Other open follow-ups (none blocking)

- OpenAI support ticket: billed-undelivered generations (user action).
- R2 orphans in `byok/` from failed attempts (list + delete, ~4 objects).
- Similarity floors 0.87/0.75 were tuned on a 1k pool — re-probe at 11k
  (DEPLOY.md §6 method).
- `HF_TOKEN` in `deploy/gmi/.env` invalid — rotate if HF seeding is wanted.
- Star badge reappears automatically when the GitHub repo goes public (one toggle).
- Post-merge hardening batch (fake-store fidelity, SPA rename affordance,
  `extra_body` collection snippet in docs examples, `providerName()` dedup,
  cap-reached indicator state) — lists at the end of `.superpowers/sdd/progress.md`.
- Stripe live config still pending (see HANDOFF-2026-07-09, unchanged).

## Research refs (for the async task)

Community/vendor findings from 2026-07-09 (searches archived in `.firecrawl/`):
~2/3 of "gpt-image-2 broken" threads are timeout/delivery; medium ~44–80s, high
p95 ~280s; fixes ranked: raise the short timeout layer, stream partials, **go async**
(job id + poll/webhook), prefer medium+compressed formats, never blind-retry
(failed deliveries still bill). Microsoft recommends ≥300s idle timeouts or
`partial_images ≥ 1` for image endpoints.
