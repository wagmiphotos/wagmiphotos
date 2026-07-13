# My Collections UX + async generation — design

_2026-07-13. Status: approved, ready for planning._

## Problem

The **My collections** tab (`#/library` → "My collections") has four rough edges reported from live use:

1. **The "New collection" card is confusing.** It's a standalone left-column card that always shows the blurb + slot-unlock message ("Generate 8 more images to unlock collection #2 (2/10 lifetime images)"). It reads as noise separate from the collections it belongs to.
2. **The "Edit theme" / "Delete" buttons look disabled** — near-invisible grey text on the light card.
3. **Generating an image disables the button** and blocks on a single in-flight job. Generation is already async server-side, so the UI should let you fire several and keep them visible — including across a page refresh.
4. **Clicking an image does nothing.** There's no way to see the prompt an image was generated from, or its stats.

## Root causes (from code)

- **New collection card** — static shell at `public/index.html:2914-2921`; body built by `renderCollCreateForm()` (`:4570-4587`). When the slot is locked, the *entire* create form is replaced by the "Generate N more…" string, so nothing composable exists.
- **Buttons** — `renderCollMeta()` (`:4589-4606`) renders Edit theme / Delete with the bare `.btn` class. `.btn` (`:1767-1782`) sets `color:#fff` with **no `background`**, so white text lands on the light card. `.btn-ghost` (`:2196-2197`: transparent bg, `1px` border, `--ink-soft` text) is the intended secondary style and is already defined.
- **Generation** — one module-scope `genBusy` flag (`:4756`) + the single `#btn-generate` element (`:2901`) enforce one-at-a-time in `createInCollection()` (`:4816-4861`). The in-flight ticket lives only in a closure (`data.generation.id`, `startTime`), so a refresh loses it; the server keeps running and refunds on timeout, but the UI can't re-attach. `pollGeneration()` (`:4780-4814`) polls one id.
- **Image click** — neither `collTile()` (`:4698-4709`) nor `libraryCard()` (`:4134-4148`) attaches a click handler. A reusable modal pattern exists (`.modal-overlay` + `hidden` toggle; `askConfirm`/`closeConfirm` at `:4295-4334`).

### Backend facts that constrain the design

- Routes are a hand-rolled dispatcher in `src/index.ts` (`:93-250`). Generation routes: `POST /v1/collections/:id/generations` → `handleCreateGeneration` (`src/generations-routes.ts:25-63`); `GET /v1/generations/:id` → `handleGetGeneration` (`:65-86`). Collection images: `GET /v1/collections/:id/images` → `handleListCollectionImages` (`src/collections-routes.ts:174-210`).
- `generations` table (migration `0016_generations.sql:11-28`): `id, user_id, collection_id, prompt (combined user+theme), provider, provider_job_id, status, asset_id, error, month, attempts, claimed_at, created_at, updated_at`. `status ∈ {queued, generating, succeeded, failed}` (`src/types.ts:125`). Only index is `idx_generations_open(status, updated_at)`. No `user_id`/`collection_id` index. `collection_id` is deliberately FK-less (rows are billing/audit history that survive collection deletion).
- **No endpoint lists pending generations.** `GenerationStore` (`src/types.ts:129-144`) exposes `get(id)` by PK and `listStale()` (global, cron-only) — no list-by-user/collection.
- Per-image payload from `handleListCollectionImages` already carries `id, prompt, thumb_url, medium_url, url, width, height, mime, model_used, source, created_at, original_url, serve_count` (`src/collections-routes.ts:199-208`) — enough for the detail modal with **no new image endpoint**.
- The cron sweep (`sweepGenerations`, `src/generation-jobs.ts:277-290`, `*/2`) drives any open generation to completion/refund even if the UI never polls it — so navigating away or refreshing never strands a job.

## Decisions (resolved during brainstorming)

- **Refresh persistence** → a **new server endpoint** (source of truth), not localStorage. Survives refresh, works across devices, and reflects true current state.
- **Concurrency** → **cap of 3** in-flight per user. Client gates best-effort; server enforces authoritatively.
- **Pending placement** → pending tiles render **in the collection's image grid** (not a separate strip).
- **Detail modal stats** → per-image only (prompt, serve count, model, dimensions, date). Collection-level `search_count` and month-level spend are **not** shown per-image.

---

## Design

### A. New collection → Add button + modal (in *Your collections*)

- Remove the standalone "New collection" card (`public/index.html:2914-2921`) and `renderCollCreateForm()`'s card role.
- In the *Your collections* card header, add a **`+ New collection`** button beside the `#coll-view-select` dropdown. Always clickable.
- Add a **`#newcoll-modal`** (`.modal-overlay`/`.modal-card`, `hidden`, Esc + click-outside close, following `askConfirm`). Its body is rebuilt on open from current state (`currentByok`, `mySlots`):
  - **No enabled key** (`!currentByok?.enabled`) → message + a link/scroll to the key section. No form.
  - **Slot locked** (`mySlots.used < 20 && mySlots.generated < mySlots.next_required`) → the requirement text: *"Generate {next_required − generated} more image(s) to unlock collection #{used + 1} ({generated}/{next_required} lifetime images)."* No form.
  - **Unlocked** → the Name + Theme-prompt form + **Create** button (moves the markup currently in `renderCollCreateForm`). `createCollection()` is reused; on success close modal, `loadCollections()`, select the new collection.
- **Empty state:** when the user has zero collections, *Your collections* shows a short empty message + a prominent "Create your first collection" button that opens `#newcoll-modal`.
- Server still re-checks the slot gate on create (409 `collection slot locked`) — unchanged; the modal surfaces that toast if it races.

### B. Button styling fix

In `renderCollMeta()` (`:4589-4606`), change Edit theme and Delete from `class="btn"` to `class="btn-ghost"` (Delete keeps `color:var(--danger)`; add a matching danger hover if needed). Presentation-only; handlers unchanged. Audit the tab for any other bare-`.btn`-on-light-card instances and fix in the same pass.

### C. Async generation: pending tiles, cap 3, refresh-persistent

**Client state.** Replace the single `genBusy` boolean with a `pendingGens` map: `id → { collId, prompt, createdAt, startTime }`. The `#btn-generate` button is no longer disabled while generating; it is disabled only when there is no collection selected / no enabled key.

**Submit** (`createInCollection` rewrite):
1. Guard: if `pendingGens.size >= 3` → toast "You can run up to 3 generations at once — wait for one to finish" and return (no request).
2. `POST /v1/collections/:id/generations`. Immediate rejections stay as toasts: 400 content_policy, 403 byok_unconfigured, 429 cap_reached (monthly), **429 concurrent_limit** (new), 502.
3. On 202: add the ticket to `pendingGens`, **focus the viewer on the target collection** (`selectedCollId = collId`) and render a **pending tile** at the top of the grid (spinner + user prompt + live elapsed timer). Clear `#gen-prompt`. Start an independent poll.

**Poll** (`pollGeneration` per id, existing cadence: 2.5s, 6-min cap):
- `succeeded` → remove from `pendingGens`; if the viewer still shows `collId`, replace the pending tile with the real image tile (dedupe: if a tile for `image.id` already exists — e.g. the images fetch already included it — just drop the pending tile). Bump the collection counts (`loadCollections()` or targeted refresh).
- `failed` / timeout / 404×4 → convert the tile to an **error tile** (prompt + reason + a dismiss ✕). Remove from `pendingGens`.
- `401` → redirect to `#/login` only from `#/library` (unchanged behavior).

**Refresh persistence.** `loadCollectionViewer()` (`:4713-4741`), after fetching images, also calls the new pending endpoint for that collection, merges results into `pendingGens`, renders a pending tile for each not already shown, and starts a poll for each. Completed generations already appear as images; failed-while-away ones are simply absent (already refunded) — we do not resurrect old error tiles.

**Grid.** `collTile()` gains a `pending` and `error` variant (spinner / error styling). The grid renders pending/error tiles first (newest), then images. Pending/error tiles are not deletable and (for pending) not clickable; error tiles have a dismiss button.

### D. Image detail modal

- `collTile()` (finished variant) gets `onclick` → `openImageModal(assetId)` using the image object already in the viewer's data (no fetch).
- Add **`#image-modal`** (`.modal-overlay`/`.modal-card`, `hidden`, Esc + click-outside). Contents:
  - `medium_url` image (fallback `url`/`thumb_url`).
  - **Prompt used** (full combined prompt), **Served N×**, **Model**, **{width}×{height}**, **created date**.
  - Actions: **Download** (`/v1/library/:id/download` or the existing download affordance used by `libraryCard`), **View original ↗** (if `original_url`), **Delete** (reuses `deleteCollectionImage` + `askConfirm`).
- Escape/keydown branch added alongside the existing modal handlers (`:4330-4334`).

### E. Backend changes

1. **List pending generations** — new route `GET /v1/collections/:id/generations?status=pending`, registered before the catch-all `collOne` regex in `src/index.ts`. Handler `handleListCollectionGenerations` (owner-only 404, mirroring the images route). Returns `{ generations: [{ id, prompt, status, created_at }] }`, `status IN ('queued','generating')`, `ORDER BY created_at DESC`, `LIMIT 20`. The `status` query param is required to equal `pending` (also the default when omitted); any other value → `400`. This keeps the surface minimal — a general history listing is out of scope.
   - New store method `GenerationStore.listPendingByCollection(collectionId, userId, limit)` in `src/d1.ts` + interface in `src/types.ts`.
2. **Concurrency cap** — in `handleCreateGeneration`, after the owner check + rate limit and before reserving spend, count the user's open generations and reject at the cap:
   - New store method `GenerationStore.countOpenByUser(userId)` → `SELECT COUNT(*) FROM generations WHERE user_id=? AND status IN ('queued','generating')`.
   - `>= 3` → `429 { error: "concurrent_limit", limit: 3 }`. Distinct from the monthly `cap_reached` so the client shows the right toast. Cap constant lives beside the other generation-jobs config.
3. **Migration `0018_generations_user_index.sql`** — `CREATE INDEX IF NOT EXISTS idx_generations_user_status ON generations(user_id, status);`. Serves both the count and the per-collection pending list (which filters `user_id` + `collection_id` + `status`; the small open-set is filtered on `collection_id` after the index narrows by user+status).
4. No changes to `handleGetGeneration`, `handleListCollectionImages`, providers, or the cron sweep.

---

## Data flow (async gen, end to end)

```
submit ─► POST /collections/:id/generations ─► 202 {generation.id}
        │                                        (server: reserve spend, INSERT generations row status=queued)
        ├─ pendingGens.add(id); render pending tile; focus viewer on collId
        └─ poll GET /generations/:id every 2.5s ─► drives one provider.check per GET
                 ├─ succeeded ─► tile → image, bump counts, pendingGens.delete
                 └─ failed/timeout ─► error tile, pendingGens.delete

refresh ─► loadCollectionViewer(collId)
        ├─ GET /collections/:id/images        ─► finished tiles (incl. any completed while away)
        └─ GET /collections/:id/generations?status=pending ─► re-render pending tiles + re-poll
```

## Error handling / edge cases

- **Dedupe on completion:** if a pending tile's succeeded asset id already exists as an image tile (images fetch raced ahead of the poll), remove the pending tile rather than adding a duplicate.
- **Cap race:** client best-effort gate can be beaten (e.g. pending in another collection not loaded this session). The server 429 `concurrent_limit` is authoritative; surface it as the same toast.
- **Failed-while-away:** not resurrected — the reservation was already refunded; showing a stale error tile is noise.
- **Collection deleted mid-generation:** pre-existing behavior (FK-less rows survive; sweep still drives them). Out of scope here.
- **Combined vs user prompt:** only the combined (user+theme) prompt is stored, so that is what the pending tile label and detail modal show. Acceptable — it is literally the prompt sent to the model.

## Testing

- **Backend (real-D1 harness, `test/real-d1.ts`):**
  - `listPendingByCollection` returns only `queued`/`generating`, excludes `succeeded`/`failed`, owner-scoped.
  - `GET /v1/collections/:id/generations?status=pending`: owner-only 404, shape, ordering, limit.
  - `countOpenByUser` + create handler: allows at 2 open, rejects the 3rd-plus with `429 concurrent_limit`; count ignores `succeeded`/`failed`.
  - Router test for the new route registration (ordering before `collOne`).
- **Migration:** 0018 applies clean on the real-migration harness.
- **Frontend (Playwright, mocked):** pending tile appears on submit and clears the prompt; cap toast at 4th; error tile on failed poll; detail modal opens with prompt/serve/model/dimensions + Download/Delete; Edit theme / Delete visibly styled (not grey); New collection modal branches (no-key / locked / unlocked). Happy-path generation deferred to prod smoke with a real key.

## Out of scope

- Cancelling an in-flight generation (no server cancel path today).
- Per-image spend / search-count stats (not tracked per-image).
- Cross-collection "Generating…" dashboard — pending tiles are per-collection by design.
- Consolidating the two collection selectors (generate-into vs view) into one — larger refactor; submit-focuses-viewer covers the immediate need.
