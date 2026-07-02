# Worker-Served Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the playground/account SPA from the Cloudflare Worker via Static Assets (same origin as the API), and update the frontend JS to the Worker's current response shape.

**Architecture:** Move `web/index.html` into `projects/worker/public/`, add an `[assets]` binding with `run_worker_first`, and make the Worker handle `/v1/*`+`/healthz` in code while delegating every other request to `env.ASSETS.fetch()`. Then fix the playground JS response handling. No separate Pages project.

**Tech Stack:** Cloudflare Workers Static Assets, TypeScript, vitest (Worker); static HTML/JS (frontend).

**Spec:** `docs/superpowers/specs/2026-07-02-worker-served-frontend-design.md` (§3 layout, §4 wiring, §5 frontend, §6 testing).

## Global Constraints

- Single origin: the Worker serves both the API and the SPA — no CORS, no separate deploy, no `projects/site`.
- API routes handled by Worker code: `GET /healthz`, `POST /v1/keys/generate`, `POST /v1/images/generations`. Unmatched `/v1/*` → `404`. Everything else → `env.ASSETS.fetch(request)` (the SPA).
- `[assets]`: `directory = "./public"`, `binding = "ASSETS"`, `run_worker_first = true`, `not_found_handling = "single-page-application"`. Requires a wrangler with Static-Assets `run_worker_first` support (≥3.90/4.x; the `^3.78` range resolves to one on `npm install`).
- Frontend response shape (from the Worker): `shared_cache = { result, similarity, cost_saved_usd, model_used, source, sizes }`; `result ∈ {hit, approximate, pending}`; a `202` response has `data: []`.
- Worker vitest stays green. The SPA itself has no unit harness (live-verified). No behavior change to the API handlers.
- Frontend edits are localized (response-handling function + a little badge CSS); the WagmiPhotos↔SharedCache branding split is OUT of scope.

## File Structure

- Move: `web/index.html` → `projects/worker/public/index.html` (repo-root `web/` removed).
- Modify: `projects/worker/wrangler.toml`, `projects/worker/src/types.ts`, `projects/worker/src/index.ts`, `projects/worker/test/router.test.ts` (Task 1); `projects/worker/public/index.html` (Task 2).

---

## Task 1: Move the SPA into the Worker + wire Static Assets

**Files:**
- Move: `web/index.html` → `projects/worker/public/index.html`
- Modify: `projects/worker/src/types.ts`, `projects/worker/src/index.ts`, `projects/worker/wrangler.toml`, `projects/worker/test/router.test.ts`

**Interfaces:**
- Produces: `Env.ASSETS: { fetch(request: Request): Promise<Response> }`; router serves the SPA via `env.ASSETS.fetch(request)` for non-API paths, `404` for unmatched `/v1/*`.

- [ ] **Step 1: Move the frontend into the Worker's assets dir**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git mv web/index.html projects/worker/public/index.html
rmdir web 2>/dev/null || true
```

- [ ] **Step 2: Update the router tests** — in `projects/worker/test/router.test.ts`: (a) add an `ASSETS` stub to the `fakeEnv` helper; (b) change the existing "unknown route" test to expect delegation to ASSETS; (c) add a test that unmatched `/v1/*` still returns 404. First read the file to match its `fakeEnv` shape, then apply:

Add to the `fakeEnv` object (alongside `DB`, `VECTORIZE`, `CLIP_TEXT_EMBED_URL`):
```ts
    ASSETS: { fetch: async () => new Response("<!doctype html><title>SPA</title>", { status: 200, headers: { "content-type": "text/html" } }) },
```

Replace the existing "unknown route 404" test and add the `/v1/*` case:
```ts
it("unknown non-API path is served by ASSETS (the SPA)", async () => {
  const res = await worker.fetch(new Request("https://x/playground"), fakeEnv());
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

it("root path is served by ASSETS", async () => {
  const res = await worker.fetch(new Request("https://x/"), fakeEnv());
  expect(res.status).toBe(200);
});

it("unmatched /v1/* still returns 404 (API semantics)", async () => {
  const res = await worker.fetch(new Request("https://x/v1/does-not-exist"), fakeEnv());
  expect(res.status).toBe(404);
});
```

- [ ] **Step 3: Run the router tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/router.test.ts`
Expected: FAIL — the current index.ts returns `404` for `/playground` and `/` (no ASSETS delegation), and `env.ASSETS` is undefined.

- [ ] **Step 4: Add `ASSETS` to the `Env` type** — in `projects/worker/src/types.ts`, add the field to the `Env` interface:

```ts
  ASSETS: { fetch(request: Request): Promise<Response> };
```
(Place it alongside `DB`/`VECTORIZE`; keep the rest of `Env` unchanged.)

- [ ] **Step 5: Change the router fallback in `projects/worker/src/index.ts`** — replace the final fallback line `return new Response("Not found", { status: 404 });` with:

```ts
      if (url.pathname.startsWith("/v1/")) {
        return new Response("Not found", { status: 404 });
      }
      return env.ASSETS.fetch(request);
```
(This stays inside the existing `try { … }`; the surrounding `catch → 502` and all `/v1/*`+`/healthz` handling are unchanged.)

- [ ] **Step 6: Add the `[assets]` block to `projects/worker/wrangler.toml`:**

```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"
```

- [ ] **Step 7: Run the full worker suite to verify green**

Run: `cd projects/worker && npx vitest run`
Expected: PASS — all files, ~33 tests (the 2 added router tests + the changed one).

- [ ] **Step 8: Commit**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git add -A
git commit -m "feat(worker): serve the SPA from the Worker via Static Assets"
```

---

## Task 2: Update the frontend to the Worker's response shape

**Files:**
- Modify: `projects/worker/public/index.html` (response-handling JS + badge CSS)

**Interfaces:**
- Consumes: the Worker's `shared_cache` shape (`result` ∈ hit/approximate/pending, `model_used`, `source`, `cost_saved_usd`, `sizes`) and the `202`/empty-`data` pending case.

No vitest (the SPA has no unit harness); verification is inspection + the worker suite staying green (unaffected).

- [ ] **Step 1: Read the response-handling block** — open `projects/worker/public/index.html` and read the generate-response handler (around lines 1630–1690: `const sc = data.shared_cache;`, the `data.data[0].url` read, the badge assignment, and the `val-provider`/`val-model` writes) plus the badge CSS (`.badge-hit`/`.badge-miss`, near line 480) and the savings counter (`sharedcache_saved` in `localStorage`).

- [ ] **Step 2: Guard the image render for the `202 pending` case.** Where the code reads the URL (currently `let rawUrl = data.data[0].url;`), make it null-safe and branch on pending:

```js
        const sc = data.shared_cache;
        const rawUrl = (data.data && data.data[0]) ? data.data[0].url : null;
        if (sc.result === 'pending' || !rawUrl) {
          // No image yet — the backfill will build it.
          outImg.removeAttribute('src');
          placeholder.textContent = 'Generating — the backfill is building this image. Check back shortly.';
          placeholder.style.display = '';
        } else {
          // ...existing image-render path, using rawUrl (memory:// rewrite etc. unchanged)...
        }
```
(Keep the existing `memory://` → `/memory/...` rewrite and `outImg.src = finalUrl` inside the `else`. `placeholder`/`outImg` are the existing elements the handler already references — reuse them.)

- [ ] **Step 3: Fix the metadata + badge fields.** Apply these exact replacements:

```js
// badge — was: `result-badge ${sc.result === 'hit' ? 'badge-hit' : 'badge-miss'}`
badge.className = `result-badge badge-${sc.result}`;
badge.textContent = sc.result;

// detail rows — was: sc.provider / sc.model
document.getElementById('val-provider').textContent = sc.model_used;
document.getElementById('val-model').textContent = sc.source;
```
Also relabel the two visible detail-row labels so they read **"Model"** (for `model_used`) and **"Source"** (for `source`) instead of "Provider"/"Model" (find the label text next to `id="val-provider"` / `id="val-model"`).

- [ ] **Step 4: Add badge CSS for the new result values** — next to the existing `.badge-hit` / `.badge-miss` rules, add:

```css
    .badge-approximate { background: #fbbf24; color: #1f2937; }
    .badge-pending { background: #6b7280; color: #fff; }
    .badge-hit { /* keep existing */ }
```
(Reuse the existing `.badge-hit` styling; `.badge-miss` may remain for old history entries.)

- [ ] **Step 5: Drive the savings counter from `cost_saved_usd`.** Where the running total is updated (the `saved` variable persisted to `localStorage['sharedcache_saved']`), increment by the server-provided value rather than gating on `result === 'hit'`:

```js
        saved += (sc.cost_saved_usd || 0);
```
(The Worker already returns the correct `cost_saved_usd`: nonzero for hit/approximate, 0 for pending.)

- [ ] **Step 6: Confirm the worker suite is unaffected**

Run: `cd projects/worker && npx vitest run`
Expected: PASS (unchanged — the SPA isn't loaded by the handler tests). If `wrangler dev` is available offline, optionally `npx wrangler dev` and load `/` to eyeball the badge/pending states; if not, note it as a live-verify step.

- [ ] **Step 7: Commit**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git add projects/worker/public/index.html
git commit -m "fix(site): render Worker response shape (model_used/source, hit/approximate/pending, 202 guard)"
```

---

## Self-Review Notes (author checklist — done)

- **Spec coverage:** §3 move → Task 1 Step 1; §4 wiring (assets/Env/index fallback/404) → Task 1 Steps 4–6; §5 frontend (result values, model_used/source, 202 guard, savings, badge CSS) → Task 2 Steps 2–5; §6 testing (router-test updates, /v1/foo 404, SPA live-verify) → Task 1 Step 2 + Task 2 Step 6.
- **Placeholder scan:** the frontend edits reference the existing `outImg`/`placeholder`/`badge`/`val-*` elements and the `saved`/`localStorage` counter that the file already contains (Task 2 Step 1 reads them first); the exact old→new fragments are given. No "handle edge cases" hand-waving.
- **Type consistency:** `Env.ASSETS.fetch` (Task 1 Step 4) matches the `env.ASSETS.fetch(request)` call (Step 5) and the `fakeEnv.ASSETS.fetch` stub (Step 2); `sc.model_used`/`sc.source`/`sc.result`/`sc.cost_saved_usd` match the Worker's response fields.
- **Ordering:** wiring first (vitest-verifiable), then the JS fix (inspection/live) — each an independently reviewable deliverable.
