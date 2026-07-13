# My Collections UX + async generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the My Collections tab — move New-collection into a modal, fix disabled-looking buttons, make BYOK generation show in-grid "pending" tiles (up to 3 at once, surviving refresh), and add an image-detail modal.

**Architecture:** Backend adds two owner-scoped `generations` reads (an in-flight count and a pending-list endpoint) plus an index migration; the create handler enforces a concurrency cap. The frontend (single file `public/index.html`) replaces the one-at-a-time `genBusy` model with a `pendingGens` map that renders pending/error tiles into the collection grid and re-attaches to in-flight jobs on load via the new endpoint.

**Tech Stack:** Cloudflare Worker (TypeScript), vitest (unit + `real-d1.ts` real-schema harness), vanilla JS/HTML/CSS SPA, D1/SQLite, Playwright MCP for browser verification.

**Spec:** `docs/superpowers/specs/2026-07-13-my-collections-ux-async-gen-design.md`

## Global Constraints

- **Concurrency cap = 3** in-flight generations per user. Server-authoritative (429 `concurrent_limit`); the client mirrors it as a soft pre-check. Copy the literal `3` in both places with a cross-reference comment.
- **New generation-list route MUST be registered before the `collOne` catch-all** regex `/^\/v1\/collections\/([^/]+)$/` in `src/index.ts` (same ordering rule the `/images` and `/generations` POST routes already follow).
- **`generations.collection_id` has NO foreign key** (rows are billing/audit history that survive collection deletion) — do not add one.
- **All asset reads go through the `live_assets` view** (existing invariant) — the new code adds no direct `assets`-table reads.
- **Migrations are append-only.** The next migration number is **0018**.
- **Poll cadence reused as-is:** `GEN_POLL_MS = 2500`, `GEN_POLL_MAX_MS = 6 * 60 * 1000`. Each pending tile runs its own poll loop on this cadence.
- **Prompt shown to the user is the stored combined (user+theme) prompt** — that is the only prompt persisted.
- Run the worker suite with `npm test` (which is `vitest run`) from `projects/worker/`. `npx tsc --noEmit` must stay silent.

---

### Task 1: Backend store methods + index migration

Adds the two owner-scoped reads the cap (Task 2) and the pending endpoint (Task 3) depend on, plus the index. Real impl + fake impl + real-schema test land together so both later tasks compile.

**Files:**
- Create: `projects/worker/migrations/0018_generations_user_index.sql`
- Modify: `projects/worker/src/types.ts` (add two methods to `GenerationStore`, after `listStale` at `:143`)
- Modify: `projects/worker/src/d1.ts` (add two impls to the `generations` object, after `listStale` at `:399`)
- Modify: `projects/worker/test/fakes.ts` (add two impls to the `generations` fake, after `listStale` at `:166`)
- Test: `projects/worker/test/d1-real-schema.test.ts` (append one test)

**Interfaces:**
- Produces:
  - `GenerationStore.countOpenByUser(userId: string): Promise<number>` — count of `queued`+`generating` rows for the user.
  - `GenerationStore.listPendingByCollection(collectionId: string, userId: string, limit: number): Promise<GenerationRow[]>` — owner-scoped `queued`+`generating` rows in one collection, newest first.

- [ ] **Step 1: Write the failing real-schema test**

Append to `projects/worker/test/d1-real-schema.test.ts` (it already imports `makeD1Stores`, `realDb`, and has `seedUser`):

```ts
it("generations: countOpenByUser + listPendingByCollection are owner+status scoped (real schema)", async () => {
  const db = realDb();
  seedUser(db, "usr_1");
  seedUser(db, "usr_2");
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "g1", userId: "usr_1", collectionId: "col_a", prompt: "p1", provider: "gmicloud", month: "2026-07" });
  await generations.create({ id: "g2", userId: "usr_1", collectionId: "col_a", prompt: "p2", provider: "gmicloud", month: "2026-07" });
  await generations.create({ id: "g3", userId: "usr_1", collectionId: "col_a", prompt: "p3", provider: "gmicloud", month: "2026-07" });
  await generations.succeed("g3", "asset-3");                 // terminal — excluded
  await generations.create({ id: "g4", userId: "usr_1", collectionId: "col_b", prompt: "p4", provider: "gmicloud", month: "2026-07" });
  await generations.create({ id: "g5", userId: "usr_2", collectionId: "col_a", prompt: "p5", provider: "gmicloud", month: "2026-07" });

  expect(await generations.countOpenByUser("usr_1")).toBe(3); // g1,g2 open + g4 open; g3 succeeded, g5 other user
  const pend = await generations.listPendingByCollection("col_a", "usr_1", 20);
  expect(pend.map((r) => r.id).sort()).toEqual(["g1", "g2"]); // col_a + usr_1 + open only
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd projects/worker && npx vitest run test/d1-real-schema.test.ts -t "countOpenByUser"`
Expected: FAIL — `generations.countOpenByUser is not a function`.

- [ ] **Step 3: Add the interface methods**

In `src/types.ts`, inside `interface GenerationStore`, immediately after the `listStale(...)` line (`:143`):

```ts
  /** Count of the user's still-open (queued|generating) generations — the concurrency gate. */
  countOpenByUser(userId: string): Promise<number>;
  /** Owner-scoped open generations in one collection, newest first — powers refresh re-attach. */
  listPendingByCollection(collectionId: string, userId: string, limit: number): Promise<GenerationRow[]>;
```

- [ ] **Step 4: Add the D1 implementations**

In `src/d1.ts`, inside the `generations` object, immediately after the `listStale` impl (before the closing `};` at `:400`):

```ts
    async countOpenByUser(userId) {
      const row = await db.prepare(
        "SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ('queued','generating')"
      ).bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
    async listPendingByCollection(collectionId, userId, limit) {
      const { results } = await db.prepare(
        `SELECT ${GEN_COLS} FROM generations WHERE collection_id = ? AND user_id = ? AND status IN ('queued','generating') ORDER BY created_at DESC LIMIT ?`
      ).bind(collectionId, userId, limit).all<GenerationRow>();
      return results ?? [];
    },
```

- [ ] **Step 5: Add the fake implementations**

In `test/fakes.ts`, inside the `generations` fake object, immediately after the `listStale` impl (`:166`), before the closing `},`:

```ts
      countOpenByUser: async (userId) =>
        [...generationRows.values()].filter((r) => r.user_id === userId && (r.status === "queued" || r.status === "generating")).length,
      listPendingByCollection: async (collectionId, userId, limit) =>
        [...generationRows.values()]
          .filter((r) => r.collection_id === collectionId && r.user_id === userId && (r.status === "queued" || r.status === "generating"))
          .slice(0, limit),
```

- [ ] **Step 6: Create the migration**

`projects/worker/migrations/0018_generations_user_index.sql`:

```sql
-- Owner-scoped reads on generations added 2026-07-13:
--   countOpenByUser        (WHERE user_id = ? AND status IN (...))  — the concurrency gate
--   listPendingByCollection(WHERE collection_id = ? AND user_id = ? AND status IN (...))
-- 0016 only indexed (status, updated_at) for the global cron sweep.
CREATE INDEX IF NOT EXISTS idx_generations_user_status ON generations(user_id, status);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd projects/worker && npx vitest run test/d1-real-schema.test.ts -t "countOpenByUser"`
Expected: PASS. (`realDb()` applies every migration in `migrations/`, so 0018 runs.)

- [ ] **Step 8: Typecheck + full suite**

Run: `cd projects/worker && npx tsc --noEmit && npm test`
Expected: tsc silent; all tests green (the fake now satisfies the widened `GenerationStore` interface, so previously-passing route/handler suites still compile).

- [ ] **Step 9: Commit**

```bash
git add projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/test/fakes.ts projects/worker/test/d1-real-schema.test.ts projects/worker/migrations/0018_generations_user_index.sql
git commit -m "feat(worker): generations countOpenByUser + listPendingByCollection + index 0018"
```

---

### Task 2: Concurrency cap in the create handler

**Files:**
- Modify: `projects/worker/src/generations-routes.ts` (add a module const + a guard in `handleCreateGeneration`)
- Test: `projects/worker/test/generations-routes.test.ts` (append one test)

**Interfaces:**
- Consumes: `GenerationStore.countOpenByUser` (Task 1).
- Produces: `429 { error: "concurrent_limit", limit: 3 }` from `POST /v1/collections/:id/generations` when the user already has 3 open generations. Exported const `MAX_CONCURRENT_GENERATIONS = 3`.

- [ ] **Step 1: Write the failing test**

Append to `projects/worker/test/generations-routes.test.ts` (helpers `fakeServices`, `giveByok`, `req`, `jobCfg`, `DEV_ENV`, `DEV_USER_ID`, `MONTH` are already in the file):

```ts
it("18. create: 3 already open -> 429 {error:'concurrent_limit', limit:3}", async () => {
  const s = fakeServices();
  const id = "col_conc18";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");
  // three open generations already in flight for this user
  for (const gid of ["o1", "o2", "o3"]) {
    await s.generations.create({ id: gid, userId: DEV_USER_ID, collectionId: id, prompt: "x", provider: "gmicloud", month: MONTH });
  }
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(429);
  const body: any = await res.json();
  expect(body.error).toBe("concurrent_limit");
  expect(body.limit).toBe(3);
});

it("19. create: 2 open still allows a 3rd -> 202", async () => {
  const s = fakeServices();
  const id = "col_conc19";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");
  for (const gid of ["p1", "p2"]) {
    await s.generations.create({ id: gid, userId: DEV_USER_ID, collectionId: id, prompt: "x", provider: "gmicloud", month: MONTH });
  }
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(202);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd projects/worker && npx vitest run test/generations-routes.test.ts -t "concurrent_limit"`
Expected: FAIL — returns 202 (no cap yet), not 429.

- [ ] **Step 3: Add the const**

In `src/generations-routes.ts`, after the imports (below line 6), add:

```ts
// Soft-parallelism guard: a user may have this many generations in flight at
// once. Mirrored client-side as a pre-check; this server value is authoritative.
export const MAX_CONCURRENT_GENERATIONS = 3;
```

- [ ] **Step 4: Add the guard**

In `handleCreateGeneration`, immediately after the rate-limiter block (after line 34, before `let body: any;`):

```ts
  if ((await s.generations.countOpenByUser(p.userId)) >= MAX_CONCURRENT_GENERATIONS) {
    return Response.json({ error: "concurrent_limit", limit: MAX_CONCURRENT_GENERATIONS }, { status: 429 });
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd projects/worker && npx vitest run test/generations-routes.test.ts`
Expected: tests 18 + 19 PASS; the whole file stays green (existing happy-path tests start from 0 open, so the guard is a no-op for them).

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/generations-routes.ts projects/worker/test/generations-routes.test.ts
git commit -m "feat(worker): cap BYOK generations at 3 concurrent per user (429 concurrent_limit)"
```

---

### Task 3: `GET /v1/collections/:id/generations?status=pending`

**Files:**
- Modify: `projects/worker/src/generations-routes.ts` (add `handleListCollectionGenerations`)
- Modify: `projects/worker/src/index.ts` (register GET on the existing `genCreate` regex, after the POST branch at `:157`)
- Test: `projects/worker/test/generations-routes.test.ts` (append handler tests)
- Test: `projects/worker/test/router.test.ts` (append a route-registration test)

**Interfaces:**
- Consumes: `GenerationStore.listPendingByCollection` (Task 1).
- Produces: `GET /v1/collections/:id/generations?status=pending` (owner-only) → `200 { generations: [{ id, prompt, status, created_at }] }`; non-owner/unknown → `404 { error: "unknown collection" }`; `status` other than `pending` → `400 { error: "unsupported status" }`.

- [ ] **Step 1: Write the failing handler tests**

Append to `projects/worker/test/generations-routes.test.ts`. Add `handleListCollectionGenerations` to the import on line 2:

```ts
import { handleCreateGeneration, handleGetGeneration, handleListCollectionGenerations } from "../src/generations-routes";
```

Then the tests:

```ts
it("20. list pending: unknown/again someone else's collection -> 404", async () => {
  const s = fakeServices();
  await s.collections.create({ id: "col_theirs20", ownerUserId: "usr_other", name: "n", themePrompt: "" });
  const res = await handleListCollectionGenerations(
    "col_theirs20", new URL("https://x/v1/collections/col_theirs20/generations?status=pending"),
    req("/v1/collections/col_theirs20/generations"), DEV_ENV, s
  );
  expect(res.status).toBe(404);
});

it("21. list pending: returns only this collection's open gens, newest first", async () => {
  const s = fakeServices();
  const id = "col_mine21";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await s.generations.create({ id: "a", userId: DEV_USER_ID, collectionId: id, prompt: "first", provider: "gmicloud", month: MONTH });
  await s.generations.create({ id: "b", userId: DEV_USER_ID, collectionId: id, prompt: "second", provider: "gmicloud", month: MONTH });
  await s.generations.create({ id: "c", userId: DEV_USER_ID, collectionId: id, prompt: "done", provider: "gmicloud", month: MONTH });
  await s.generations.succeed("c", "asset-c");            // excluded (terminal)
  await s.generations.create({ id: "d", userId: DEV_USER_ID, collectionId: "col_other21", prompt: "elsewhere", provider: "gmicloud", month: MONTH });
  const res = await handleListCollectionGenerations(
    id, new URL(`https://x/v1/collections/${id}/generations?status=pending`),
    req(`/v1/collections/${id}/generations`), DEV_ENV, s
  );
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.generations.map((g: any) => g.id).sort()).toEqual(["a", "b"]);
  expect(body.generations[0]).toHaveProperty("prompt");
  expect(body.generations[0]).toHaveProperty("created_at");
});

it("22. list pending: unsupported status value -> 400", async () => {
  const s = fakeServices();
  const id = "col_stat22";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  const res = await handleListCollectionGenerations(
    id, new URL(`https://x/v1/collections/${id}/generations?status=succeeded`),
    req(`/v1/collections/${id}/generations`), DEV_ENV, s
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd projects/worker && npx vitest run test/generations-routes.test.ts -t "list pending"`
Expected: FAIL — `handleListCollectionGenerations` is not exported.

- [ ] **Step 3: Implement the handler**

In `src/generations-routes.ts`, add after `handleCreateGeneration` (before `handleGetGeneration`):

```ts
export async function handleListCollectionGenerations(
  collectionId: string, url: URL, request: Request, env: Env, s: Services
): Promise<Response> {
  const p = await resolveApiPrincipal(request, env, s);
  if (!p) return Response.json({ error: "login required" }, { status: 401 });
  const coll = await s.collections.get(collectionId);
  if (!coll || coll.owner_user_id !== p.userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  const status = url.searchParams.get("status") ?? "pending";
  if (status !== "pending") return Response.json({ error: "unsupported status" }, { status: 400 });
  const rows = await s.generations.listPendingByCollection(collectionId, p.userId, 20);
  return Response.json({
    generations: rows.map((r) => ({ id: r.id, prompt: r.prompt, status: r.status, created_at: r.created_at })),
  });
}
```

- [ ] **Step 4: Register the route**

In `src/index.ts`, immediately after the `genCreate` POST block (after line 157, before the `genGet` block):

```ts
      if (genCreate && request.method === "GET") {
        let id: string;
        try { id = decodeURIComponent(genCreate[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleListCollectionGenerations(id, url, request, env, services);
      }
```

Add `handleListCollectionGenerations` to the existing import of `handleCreateGeneration`/`handleGetGeneration` near the top of `src/index.ts`.

- [ ] **Step 5: Write the router registration test**

Append to `projects/worker/test/router.test.ts` (proves the GET dispatches to the handler, not the `/v1/*` catch-all — the handler answers a missing collection with JSON `unknown collection`, whereas the catch-all returns text "Not found"):

```ts
it("GET /v1/collections/:id/generations dispatches to the pending-list handler (not the catch-all)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/collections/col_x/generations?status=pending"),
    fakeEnv(), { waitUntil: () => {} } as any
  );
  expect(res.status).toBe(404);
  const body: any = await res.json();
  expect(body.error).toBe("unknown collection"); // handler ran; DB stub has no such collection
});
```

- [ ] **Step 6: Run to verify all pass**

Run: `cd projects/worker && npx vitest run test/generations-routes.test.ts test/router.test.ts && npx tsc --noEmit`
Expected: all green; tsc silent.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/src/generations-routes.ts projects/worker/src/index.ts projects/worker/test/generations-routes.test.ts projects/worker/test/router.test.ts
git commit -m "feat(worker): GET /v1/collections/:id/generations?status=pending (owner-only)"
```

---

## Frontend tasks (public/index.html)

The SPA has no JS unit harness (all `.test.ts` are backend). Frontend tasks verify in a real browser via the Playwright MCP against a static server, following the repo's established "Playwright smoke by implementer" pattern. Boot once per task:

```bash
cd projects/worker/public && python3 -m http.server 8791   # run in background; kill when done
```

Then `browser_navigate http://localhost:8791/index.html`. API calls 404 against the static server, so tests **stub `window.fetch`** and **drive render functions directly** via `browser_evaluate`. The true generation happy-path is deferred to prod smoke with a real key (generation can't run offline — no Workers AI/Vectorize).

---

### Task 4: Fix the disabled-looking Edit theme / Delete buttons

**Files:**
- Modify: `projects/worker/public/index.html` (`renderCollMeta`, the two buttons at `:4602-4603`)

- [ ] **Step 1: Change the classes**

In `renderCollMeta()`, change the Edit theme and Delete buttons from `class="btn"` to `class="btn-ghost"`. Keep the Delete button's `color:var(--danger)` inline style and its sizing inline styles. Result:

```js
      <button class="btn-ghost" style="height:38px;width:auto;padding:0 14px;font-size:0.8125rem;" onclick="editCollectionTheme('${c.id}')">Edit theme</button>
      <button class="btn-ghost" style="height:38px;width:auto;padding:0 14px;font-size:0.8125rem;color:var(--danger);" onclick="deleteCollection('${c.id}', this)">Delete</button>
```

- [ ] **Step 2: Grep for other bare `.btn` on light cards in this tab**

Run: `grep -n 'class="btn"' projects/worker/public/index.html`
For each hit inside the collections tab (`#tab-collections`) or its cards that renders on a light background, switch to `btn-ghost` (secondary) or `btn-primary` (primary action) as appropriate. Leave `btn-primary`/`btn-ghost`/other-classed buttons alone. Note in the commit which were changed.

- [ ] **Step 3: Verify in browser**

Start the static server, navigate, then inject a fake collection and render the meta row:

```js
// browser_evaluate
myCollections = [{ id: 'col_demo', name: 'Demo', theme_prompt: '90s retro', image_count: 0, total_serves: 0, search_count: 2, created_at: '', updated_at: '' }];
selectedCollId = 'col_demo';
renderCollMeta();
const btn = [...document.querySelectorAll('#coll-meta button')].find(b => b.textContent.trim() === 'Edit theme');
const cs = getComputedStyle(btn);
return { border: cs.borderTopWidth, color: cs.color };  // expect a visible 1px border + readable (non-white) text
```

Expected: `border` is `1px` (not `0px`); `color` is the ink-soft grey (roughly `rgb(90-120,...)`), not `rgb(255, 255, 255)`. Take a screenshot to confirm both buttons read as real, enabled buttons.

- [ ] **Step 4: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "fix(spa): Edit theme / Delete buttons use btn-ghost (were invisible bare .btn)"
```

---

### Task 5: New collection → Add button + state-branching modal

**Files:**
- Modify: `projects/worker/public/index.html` — remove the standalone "New collection" card (`:2914-2921`); add a `+ New collection` button in the *Your collections* header (`:2924-2940`); add a `#newcoll-modal` block near the other modals (`~:3628`); rework `renderCollCreateForm()` (`:4570-4587`) into a modal-body builder; add open/close + Escape wiring.

**Interfaces:**
- Consumes: `currentByok`, `mySlots`, `createCollection()`, `loadCollections()`, `escapeHtml()`, the `.modal-overlay/.modal-card` pattern.
- Produces: `openNewCollModal()`, `closeNewCollModal()`, `renderNewCollBody()`.

- [ ] **Step 1: Remove the standalone card**

Delete the `<!-- New Collection Card -->` block at `:2914-2921` (the `glass-card` with `<h2>New collection</h2>` and `#coll-create-body`).

- [ ] **Step 2: Add the Add button to the *Your collections* header**

In the *Your collections* card (`:2924-2940`), add next to the `#coll-view-select` dropdown label a button:

```html
<button type="button" class="btn-ghost" style="height:34px;width:auto;padding:0 12px;font-size:0.8125rem;" onclick="openNewCollModal()">+ New collection</button>
```

If the card has a header row, place it there; otherwise add a small flex header row above `#coll-view-select` containing the title and this button.

- [ ] **Step 3: Add the modal markup**

Near the other modals (after `#theme-modal` ends, `~:3639`), add:

```html
<div id="newcoll-modal" class="modal-overlay" hidden onclick="if(event.target===this)closeNewCollModal()">
  <div class="modal-card">
    <div class="modal-title">New collection</div>
    <p class="modal-sub">A themed set of images generated with your own key. The theme prompt is appended to every image you generate into it. Collections are public — the name and theme are checked automatically, so keep them family-friendly.</p>
    <div id="newcoll-body"></div>
    <div class="modal-actions"><button type="button" class="btn-ghost" onclick="closeNewCollModal()">Close</button></div>
  </div>
</div>
```

- [ ] **Step 4: Replace `renderCollCreateForm` with the modal-body builder + open/close**

Replace `renderCollCreateForm()` (`:4570-4587`) with:

```js
function renderNewCollBody() {
  const el = document.getElementById('newcoll-body');
  if (!el) return;
  const canCreate = !!(currentByok && currentByok.enabled);
  const slotLocked = !!(mySlots && mySlots.used < 20 && mySlots.generated < mySlots.next_required);
  if (!canCreate) {
    el.innerHTML = `<div style="font-size:0.8125rem;color:var(--muted);">Add an enabled provider key first (Account → keys, or the key panel) to create collections.</div>`;
    return;
  }
  if (slotLocked) {
    const need = mySlots.next_required - mySlots.generated;
    el.innerHTML = `<div style="font-size:0.8125rem;color:var(--muted);">Generate ${need} more image${need === 1 ? '' : 's'} to unlock collection #${mySlots.used + 1} (${mySlots.generated}/${mySlots.next_required} lifetime images).</div>`;
    return;
  }
  el.innerHTML = `
    <div class="form-group">
      <label>Name</label>
      <input id="coll-name" placeholder="e.g. Retro posters" maxlength="80" class="field-input">
      <label style="margin-top:10px;">Theme prompt (appended to every generation)</label>
      <textarea id="coll-theme" maxlength="500" placeholder="e.g. retro travel poster style, muted palette" class="field-input" style="min-height:60px;"></textarea>
      <button class="btn btn-primary" style="height:40px;width:auto;padding:0 18px;margin-top:12px;" onclick="createCollection(this)">Create collection</button>
    </div>`;
}
function openNewCollModal() { renderNewCollBody(); document.getElementById('newcoll-modal').hidden = false; }
function closeNewCollModal() { document.getElementById('newcoll-modal').hidden = true; }
```

- [ ] **Step 5: Close the modal on successful create**

In `createCollection()` (`:4613-4642`), on the success path (after it currently calls `loadCollections()` / selects the new collection), add `closeNewCollModal();`. Leave the 409 slot-locked toast branch as-is (it stays open so the user sees the message).

- [ ] **Step 6: Remove stale references + wire Escape**

- Remove any remaining call to `renderCollCreateForm()` (e.g. inside `renderCollections()` at `:4549-4568`) — the create form no longer renders inline.
- In the Escape `keydown` handler (`:4330-4334`), add: `if (!document.getElementById('newcoll-modal').hidden) closeNewCollModal();`
- Empty-state: where the viewer renders "no collections" (in `renderCollections()` when `myCollections.length === 0`), show a prominent `<button class="btn btn-primary" onclick="openNewCollModal()">Create your first collection</button>` alongside the empty text.

- [ ] **Step 7: Verify in browser**

Start server, navigate, then exercise all three branches:

```js
// browser_evaluate — locked state
currentByok = { enabled: true }; mySlots = { used: 1, generated: 2, next_required: 10 };
openNewCollModal();
return document.getElementById('newcoll-body').textContent;   // expect "Generate 8 more images to unlock collection #2 (2/10 lifetime images)."
```
```js
// unlocked state
mySlots = { used: 0, generated: 0, next_required: 1 }; renderNewCollBody();
return !!document.getElementById('coll-name');                // expect true (form present)
```
```js
// no-key state
currentByok = { enabled: false }; renderNewCollBody();
return document.getElementById('newcoll-body').textContent;   // expect the "Add an enabled provider key" message
```
Screenshot the unlocked modal. Confirm click-outside and the Close button hide it (`document.getElementById('newcoll-modal').hidden === true`).

- [ ] **Step 8: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(spa): New collection is an Add button + state-branching modal in Your collections"
```

---

### Task 6: Image detail modal on tile click

**Files:**
- Modify: `projects/worker/public/index.html` — add `#image-modal` markup (near other modals); add `openImageModal()`/`closeImageModal()`; make finished `collTile()` clickable (`:4698-4709`); Escape wiring.

**Interfaces:**
- Consumes: the current collection's image objects (already in memory — the array `loadCollectionViewer` maps over). Each has `id, prompt, thumb_url, medium_url, url, width, height, mime, model_used, source, created_at, original_url, serve_count`.
- Produces: `openImageModal(assetId)`, `closeImageModal()`, and a module-level `collViewerImages` array holding the last-rendered image objects (so the modal reads from memory, no fetch).

- [ ] **Step 1: Capture the rendered images in memory**

In `loadCollectionViewer()` (`:4713-4741`), where it computes the `images` array before mapping to `collTile`, assign it to a module-scope variable so the modal can look one up:

```js
collViewerImages = images;   // module-scope: let collViewerImages = [];  (declare near the other viewer state)
```

- [ ] **Step 2: Make finished tiles clickable**

In `collTile(img)` (`:4698-4709`), add an `onclick` to the tile container (finished variant only — Task 7 adds pending/error variants that are not clickable). The image element gets `style="cursor:pointer;"` and the tile calls `openImageModal`:

```js
    <div class="coll-tile" onclick="openImageModal('${img.id}')" style="cursor:pointer;">
      <img src="${escapeHtml(thumb)}" alt="${escapeHtml(img.prompt)}" title="${escapeHtml(img.prompt)}">
      ${serves}
      <button type="button" class="tile-del" aria-label="Delete image" title="Delete image" onclick="event.stopPropagation();deleteCollectionImage('${selectedCollId}', '${img.id}')">✕</button>
    </div>
```
(Note `event.stopPropagation()` on the delete button so deleting doesn't also open the modal.)

- [ ] **Step 3: Add the modal markup**

Near the other modals, add:

```html
<div id="image-modal" class="modal-overlay" hidden onclick="if(event.target===this)closeImageModal()">
  <div class="modal-card" style="max-width:640px;">
    <img id="imgmodal-img" alt="" style="width:100%;border-radius:10px;margin-bottom:12px;">
    <div id="imgmodal-meta" style="font-size:0.8125rem;color:var(--muted);line-height:1.7;"></div>
    <div class="modal-actions" id="imgmodal-actions"></div>
  </div>
</div>
```

- [ ] **Step 4: Add open/close**

```js
function openImageModal(assetId) {
  const img = (collViewerImages || []).find((i) => i.id === assetId);
  if (!img) return;
  document.getElementById('imgmodal-img').src = img.medium_url || img.url || img.thumb_url;
  const dims = (img.width && img.height) ? `${img.width}×${img.height}` : '—';
  const served = img.serve_count != null ? `${img.serve_count}×` : '—';
  document.getElementById('imgmodal-meta').innerHTML = `
    <div style="margin-bottom:8px;"><b style="color:var(--ink);">Prompt</b><br>${escapeHtml(img.prompt || '')}</div>
    <div>Served <b style="color:var(--ink);">${served}</b> by the API</div>
    <div>Model: ${escapeHtml(img.model_used || '—')} · ${dims}</div>
    <div>Created: ${escapeHtml(img.created_at || '—')}</div>`;
  const dl = `<a class="btn-ghost" style="height:34px;display:inline-flex;align-items:center;padding:0 12px;text-decoration:none;" href="/v1/library/${encodeURIComponent(img.id)}/download">Download</a>`;
  const orig = img.original_url ? `<a class="btn-ghost" style="height:34px;display:inline-flex;align-items:center;padding:0 12px;text-decoration:none;" href="${escapeHtml(img.original_url)}" target="_blank" rel="noopener">View original ↗</a>` : '';
  const del = `<button type="button" class="btn-ghost" style="height:34px;padding:0 12px;color:var(--danger);" onclick="closeImageModal();deleteCollectionImage('${selectedCollId}', '${img.id}')">Delete</button>`;
  document.getElementById('imgmodal-actions').innerHTML = dl + orig + del +
    `<button type="button" class="btn-ghost" style="height:34px;padding:0 12px;" onclick="closeImageModal()">Close</button>`;
  document.getElementById('image-modal').hidden = false;
}
function closeImageModal() { document.getElementById('image-modal').hidden = true; }
```
(Confirm the download route is `/v1/library/:id/download` — it's the one `libraryCard` links to; reuse whatever that renderer uses.)

- [ ] **Step 5: Escape wiring**

In the Escape handler (`:4330-4334`), add: `if (!document.getElementById('image-modal').hidden) closeImageModal();`

- [ ] **Step 6: Verify in browser**

```js
// browser_evaluate
collViewerImages = [{ id: 'a1', prompt: 'a red fox in snow', serve_count: 7, model_used: 'gpt-image-2', width: 1024, height: 1024, medium_url: '/assets/nice.webp', created_at: '2026-07-12 10:00:00', original_url: '' }];
selectedCollId = 'col_demo';
openImageModal('a1');
const t = document.getElementById('imgmodal-meta').textContent;
return { hidden: document.getElementById('image-modal').hidden, hasPrompt: t.includes('a red fox in snow'), hasServed: t.includes('7×'), hasModel: t.includes('gpt-image-2') };
```
Expected: `{ hidden: false, hasPrompt: true, hasServed: true, hasModel: true }`. Screenshot the modal. Confirm Close/click-outside hide it.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(spa): image-detail modal on tile click (prompt, served×, model, download/original/delete)"
```

---

### Task 7: Async generation — pending/error tiles, cap 3, submit/poll rewrite

**Files:**
- Modify: `projects/worker/public/index.html` — replace `genBusy` (`:4756`) with a `pendingGens` map; rewrite `createInCollection()` (`:4816-4861`) and `pollGeneration()` (`:4780-4814`); add pending/error variants to `collTile()`; add tile CSS.

**Interfaces:**
- Consumes: `POST /v1/collections/:id/generations` (202 `{ generation: { id, prompt, ... } }`), `GET /v1/generations/:id`, `loadCollections()`, `loadCollectionViewer()`, `showToast()`.
- Produces: module state `pendingGens` (Map: `genId → { collId, prompt, createdAt, startTime, status }`); functions `renderPendingTiles()`, `startPollFor(genId, collId, startTime)`; `collTile` handles `{ _pending: true }` and `{ _error: true, _reason }` shapes. Consumed by Task 8.

- [ ] **Step 1: Replace the busy flag with a pending map + client cap**

Replace `let genBusy = false;` (`:4756`) with:

```js
const MAX_CONCURRENT_GENERATIONS = 3;   // mirrors src/generations-routes.ts (server-authoritative)
const pendingGens = new Map();          // genId -> { collId, prompt, createdAt, startTime }
```

- [ ] **Step 2: Rewrite the submit handler**

Replace `createInCollection()` (`:4816-4861`) with:

```js
async function createInCollection() {
  const prompt = document.getElementById('gen-prompt').value.trim();
  const collId = document.getElementById('gen-coll-select').value;
  if (!prompt) { showToast('Enter a prompt first', 'error'); return; }
  if (!collId) { showToast('Create a collection first', 'error'); return; }
  if (pendingGens.size >= MAX_CONCURRENT_GENERATIONS) {
    showToast(`You can run up to ${MAX_CONCURRENT_GENERATIONS} generations at once — wait for one to finish`, 'error');
    return;
  }
  let data;
  try {
    const r = await fetch(`/v1/collections/${encodeURIComponent(collId)}/generations`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (r.status === 401) { location.hash = '#/login'; return; }
    data = await r.json().catch(() => ({}));
    if (r.status === 429 && data.error === 'concurrent_limit') { showToast(`You can run up to ${data.limit} generations at once`, 'error'); return; }
    if (r.status === 429) { showToast('Monthly cap reached for your key', 'error'); return; }
    if (r.status === 400 && data.error === 'content_policy') { showToast('That prompt was rejected by the content policy', 'error'); return; }
    if (r.status === 403) { showToast('Add an enabled provider key first', 'error'); return; }
    if (!r.ok || !data.generation) throw new Error(data.error || `Error ${r.status}`);
  } catch (e) { showToast(e.message || 'Generation failed', 'error'); return; }

  const genId = data.generation.id;
  const startTime = performance.now();
  pendingGens.set(genId, { collId, prompt, createdAt: Date.now(), startTime });
  document.getElementById('gen-prompt').value = '';       // clear so the next prompt can be typed
  // focus the viewer on the target collection so the pending tile is visible
  selectedCollId = collId;
  const viewSel = document.getElementById('coll-view-select');
  if (viewSel && viewSel.value !== collId) { viewSel.value = collId; collViewQuery = ''; }
  loadCollectionViewer(collId);                            // re-renders grid incl. the new pending tile
  startPollFor(genId, collId, startTime);
}
```

- [ ] **Step 3: Rewrite the poll loop to be per-tile (no shared button gate)**

Replace `pollGeneration()` (`:4780-4814`) with `startPollFor`:

```js
async function startPollFor(genId, collId, startTime) {
  let missing = 0;
  while (performance.now() - startTime < GEN_POLL_MAX_MS) {
    await new Promise((r) => setTimeout(r, GEN_POLL_MS));
    if (!pendingGens.has(genId)) return;                  // dismissed/replaced elsewhere
    let data, status;
    try {
      const r = await fetch(`/v1/generations/${encodeURIComponent(genId)}`, { credentials: 'same-origin' });
      status = r.status;
      if (r.status === 401) { if (location.hash.startsWith('#/library')) location.hash = '#/login'; return; }
      data = await r.json().catch(() => ({}));
    } catch { continue; }                                 // transient network — keep polling
    const gen = data && data.generation;
    if (gen && gen.status === 'succeeded') { finishPending(genId, collId); return; }
    if (gen && gen.status === 'failed') { errorPending(genId, collId, gen.error || 'Generation failed'); return; }
    if (!gen && status === 404) { missing++; if (missing >= 4) { errorPending(genId, collId, 'Generation not found'); return; } }
    else { missing = 0; }
  }
  errorPending(genId, collId, 'Timed out waiting for the image');
}
function finishPending(genId, collId) {
  pendingGens.delete(genId);
  loadCollections();                                      // refresh counts
  if (selectedCollId === collId) loadCollectionViewer(collId); // pulls the new image; dedupe is automatic (server lists it)
}
function errorPending(genId, collId, reason) {
  const p = pendingGens.get(genId);
  if (p) p._error = reason;                               // keep in map so the tile renders as error until dismissed
  if (selectedCollId === collId) loadCollectionViewer(collId);
}
function dismissPending(genId, collId) {
  pendingGens.delete(genId);
  if (selectedCollId === collId) loadCollectionViewer(collId);
}
```

- [ ] **Step 4: Render pending/error tiles in the grid**

In `loadCollectionViewer()` (`:4713-4741`), after fetching `images` for `collId` and before building the grid HTML, prepend pending/error tiles for that collection. **Keep the `collViewerImages = images;` line added in Task 6** — both live in this function.

```js
  const pend = [...pendingGens.entries()]
    .filter(([, v]) => v.collId === collId)
    .map(([id, v]) => v._error ? { _error: true, _reason: v._error, _id: id, prompt: v.prompt } : { _pending: true, _id: id, prompt: v.prompt, startTime: v.startTime });
  el.innerHTML = '<div class="coll-viewer-grid">' + pend.map(collTile).join('') + images.map(collTile).join('') + '</div>';
```

Update `collTile(img)` to branch on the pending/error shapes at the top:

```js
function collTile(img) {
  if (img._pending) {
    return `<div class="coll-tile coll-tile-pending" title="${escapeHtml(img.prompt)}">
      <div class="tile-spinner"></div>
      <div class="tile-pending-label">${escapeHtml((img.prompt || '').slice(0, 40))}</div>
    </div>`;
  }
  if (img._error) {
    return `<div class="coll-tile coll-tile-error" title="${escapeHtml(img._reason)}">
      <div class="tile-error-mark">!</div>
      <div class="tile-pending-label">${escapeHtml(img._reason)}</div>
      <button type="button" class="tile-del" aria-label="Dismiss" title="Dismiss" onclick="dismissPending('${img._id}', selectedCollId)">✕</button>
    </div>`;
  }
  const thumb = img.thumb_url || img.medium_url || img.url;
  const serves = img.serve_count != null
    ? `<span class="tile-badge" title="Times returned by the API">${img.serve_count}×</span>` : '';
  return `
    <div class="coll-tile" onclick="openImageModal('${img.id}')" style="cursor:pointer;">
      <img src="${escapeHtml(thumb)}" alt="${escapeHtml(img.prompt)}" title="${escapeHtml(img.prompt)}">
      ${serves}
      <button type="button" class="tile-del" aria-label="Delete image" title="Delete image" onclick="event.stopPropagation();deleteCollectionImage('${selectedCollId}', '${img.id}')">✕</button>
    </div>`;
}
```

- [ ] **Step 5: Add tile CSS**

Near the existing `.coll-tile` rules (`:450-465`), add:

```css
.coll-tile-pending, .coll-tile-error { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; background:var(--surface,#f5f4f2); border:1px dashed var(--line); padding:8px; text-align:center; }
.coll-tile-error { border-color:var(--danger); }
.tile-spinner { width:22px; height:22px; border:2px solid var(--line); border-top-color:var(--muted); border-radius:50%; animation:spin 0.8s linear infinite; }
.tile-error-mark { width:22px; height:22px; border-radius:50%; background:var(--danger); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; }
.tile-pending-label { font-size:0.6875rem; color:var(--muted); line-height:1.3; word-break:break-word; }
@keyframes spin { to { transform:rotate(360deg); } }
```
(If a `spin` keyframe or `--surface` var already exists, reuse it rather than redefining.)

- [ ] **Step 6: Remove dead code**

Delete the old `setGenResult`/`genLoaderHtml` calls tied to the single-flight loader if they're now unused (grep to confirm no remaining callers). Remove the `btn.disabled` toggling of `#btn-generate`. Keep `#btn-generate` enabled; it is gated only by the client cap check inside `createInCollection`.

- [ ] **Step 7: Verify in browser (stubbed)**

Start server, navigate. Stub fetch to simulate a 202 then a succeeded poll, and assert a pending tile appears then resolves:

```js
// browser_evaluate — cap toast at 4th
selectedCollId = 'col_demo';
for (let i = 0; i < 3; i++) pendingGens.set('g' + i, { collId: 'col_demo', prompt: 'p', startTime: performance.now() });
document.getElementById('gen-prompt') && (document.getElementById('gen-prompt').value = 'x');
// call the guard directly:
return pendingGens.size >= MAX_CONCURRENT_GENERATIONS;   // expect true -> submit would toast and return
```
```js
// pending tile renders
pendingGens.clear(); pendingGens.set('gTest', { collId: 'col_demo', prompt: 'a fox', startTime: performance.now() });
// stub loadCollectionViewer's image fetch to return []
window.__origFetch = window.fetch;
window.fetch = async (u) => new Response(JSON.stringify({ images: [], has_more: false }), { status: 200 });
await loadCollectionViewer('col_demo');
return document.querySelectorAll('.coll-tile-pending').length;  // expect 1
```
Restore `window.fetch = window.__origFetch;` after. Screenshot the pending tile. Then simulate error:
```js
errorPending('gTest', 'col_demo', 'boom');
return document.querySelectorAll('.coll-tile-error').length;    // expect 1
```

- [ ] **Step 8: Typecheck-free commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(spa): in-grid pending/error tiles, 3-way concurrency, no button lock"
```

---

### Task 8: Refresh persistence — re-attach to in-flight generations on load

**Files:**
- Modify: `projects/worker/public/index.html` — in `loadCollectionViewer()`, fetch the pending endpoint and re-seed `pendingGens` + re-poll.

**Interfaces:**
- Consumes: `GET /v1/collections/:id/generations?status=pending` (Task 3) → `{ generations: [{ id, prompt, status, created_at }] }`; `pendingGens`, `startPollFor` (Task 7).

- [ ] **Step 1: Fetch + merge pending on viewer load**

In `loadCollectionViewer(collId)` (Task 7 version — **preserve the Task 6 `collViewerImages` line and the Task 7 pending-tile prepend**), after fetching `images` and before rendering, fetch the collection's pending generations and merge any not already tracked, then start polling them:

```js
  // re-attach to in-flight generations for this collection (survives refresh)
  try {
    const pr = await fetch(`/v1/collections/${encodeURIComponent(collId)}/generations?status=pending`, { credentials: 'same-origin' });
    if (pr.ok) {
      const pd = await pr.json().catch(() => ({}));
      for (const g of (pd.generations || [])) {
        if (!pendingGens.has(g.id)) {
          const startTime = performance.now();            // 6-min cap restarts from now; server sweep is the real backstop
          pendingGens.set(g.id, { collId, prompt: g.prompt, createdAt: Date.now(), startTime });
          startPollFor(g.id, collId, startTime);
        }
      }
    }
  } catch { /* offline / non-owner: skip re-attach */ }
```

This runs before the grid-render line from Task 7, so the freshly-merged pending entries render as tiles in the same pass.

- [ ] **Step 2: Verify in browser (stubbed)**

Start server, navigate. Stub both fetches (images + pending) and confirm a pending tile is reconstructed with no prior client state:

```js
// browser_evaluate
pendingGens.clear();
window.__origFetch = window.fetch;
window.fetch = async (u) => {
  if (String(u).includes('/generations?status=pending')) {
    return new Response(JSON.stringify({ generations: [{ id: 'gReattach', prompt: 'restored fox', status: 'generating', created_at: '2026-07-13 00:00:00' }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ images: [], has_more: false }), { status: 200 });
};
selectedCollId = 'col_demo';
await loadCollectionViewer('col_demo');
const ok = pendingGens.has('gReattach') && document.querySelectorAll('.coll-tile-pending').length === 1;
window.fetch = window.__origFetch;
return ok;   // expect true
```
Expected: `true` — a pending tile is reconstructed purely from the endpoint. Screenshot.

- [ ] **Step 3: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(spa): re-attach to in-flight generations on collection load (refresh-persistent)"
```

---

## Final verification (after all tasks)

- [ ] `cd projects/worker && npx tsc --noEmit && npm test` — tsc silent, full suite green.
- [ ] Browser smoke of the whole tab (static server + stubs): New-collection modal branches; Edit theme/Delete visibly styled; image modal opens with stats; pending tile appears on submit and after a simulated refresh; error tile dismissable; cap toast at 4th.
- [ ] **Deferred to prod smoke with a real key** (cannot run offline): a real generation lands as a pending tile, resolves to the image ~70s later, does not appear in the shared library search, and survives an actual page refresh mid-flight.
- [ ] Deploy checklist for the operator: apply migration `0018` remote (`wrangler d1 migrations apply wagmiphotos --remote`), deploy the worker, then the prod smoke above.

## Notes carried from the spec

- **Dedupe on completion** is automatic: `finishPending` re-runs `loadCollectionViewer`, which lists the now-finished asset from the server; the pending entry was already deleted from `pendingGens`, so no duplicate tile.
- **Cap race**: the client pre-check can be beaten (pending in a collection not loaded this session); the server 429 `concurrent_limit` is authoritative and surfaces the same toast.
- **Failed-while-away** generations are not resurrected — they are absent from `?status=pending` and already refunded.
- **Cross-collection** pending: tiles are per-collection; the cron sweep drives any un-polled job to completion, so navigating away never strands one.
