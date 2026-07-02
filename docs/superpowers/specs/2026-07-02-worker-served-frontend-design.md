# Worker-Served Frontend (Cloudflare Static Assets) — Design Spec

**Date:** 2026-07-02
**Status:** Approved for planning
**Supersedes:** the idea of a separate `projects/site` Cloudflare Pages project (dropped).

## 1. Summary

Serve the playground / account-management frontend **from the Cloudflare Worker itself** via
**Workers Static Assets**, instead of a separate Pages deployment. The Worker becomes the single
deployable that serves both the API (`/v1/*`, `/healthz`) and the static SPA (everything else). Because
the UI and the API are then the **same origin**, the frontend's existing relative `fetch('/v1/...')`
calls work unchanged — no CORS, no proxy, no second deployment. The frontend's stale response-handling is
updated to the current Worker response shape as part of this change (it would otherwise not render).

The frontend is hash-routed (`#/playground`, `#/account`, …) with relative API calls — already compatible
with same-origin Worker serving.

## 2. Goals / non-goals

**Goals**
- Move `web/index.html` into the Worker project and serve it via the `[assets]` binding.
- Keep the API routes (`/v1/*`, `/healthz`) handled by Worker code; serve the SPA for all other paths.
- Update the playground JS to the current response shape so it renders correctly (keys/account UI included).
- One deployment, one origin, no CORS.

**Non-goals**
- No separate `projects/site` / Cloudflare Pages project (explicitly dropped).
- No new UI features; no visual redesign — only wire-up + response-shape fixes.
- No build step for the frontend (it's a single static `index.html`).
- No automated browser test harness for the SPA (verified live via `wrangler dev` / deploy).

## 3. Layout

- Move `web/index.html` → `projects/worker/public/index.html` (via `git mv`). The repo-root `web/` is removed.
- No other files move. `docs/`, `.env.example`, and the three Python packages are untouched.

## 4. Worker wiring (`projects/worker/`)

**`wrangler.toml`** — add a Static Assets block:
```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"
```
- `run_worker_first = true`: the Worker runs for every request and decides; API routes are handled in
  code, and non-API requests are delegated to the asset server. This avoids the asset SPA-fallback
  swallowing GET API routes like `/healthz`.
- `not_found_handling = "single-page-application"`: `env.ASSETS.fetch()` returns `index.html` for any
  unmatched asset path (belt-and-suspenders; the SPA is hash-routed so `/` is the primary path).
- Requires a wrangler version with Static Assets `run_worker_first` support (≥ 3.90 / 4.x); the project's
  `^3.78` range resolves to a compatible version on `npm install`.

**`src/types.ts`** — add `ASSETS` to `Env`:
```ts
export interface Env {
  DB: any; VECTORIZE: any; RATE_LIMITER?: any; ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string; CLIP_TEXT_EMBED_URL: string; CLIP_EMBED_TOKEN?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
}
```

**`src/index.ts`** — the router keeps the API routes and changes the fallback:
- `GET /healthz`, `POST /v1/keys/generate`, `POST /v1/images/generations` → handled by Worker code (unchanged).
- An **unmatched `/v1/*`** path → `404` (preserve API semantics).
- **Everything else** → `return env.ASSETS.fetch(request)` (serve the static SPA) instead of the old `404`.

## 5. Frontend updates (`projects/worker/public/index.html`)

The response-handling block (currently ~lines 1630–1680) is updated to the Worker's response shape
(spec of the Worker: `shared_cache = { result, similarity, cost_saved_usd, model_used, source, sizes }`,
`result ∈ {hit, approximate, pending}`; a `202 pending` response has `data: []`):

1. **Result values:** handle `hit` / `approximate` / `pending` (not `hit`/`miss`). Badge class/text derive
   from `sc.result` (e.g. `badge-${sc.result}`); add CSS for `badge-approximate` / `badge-pending`
   alongside the existing hit/miss styles.
2. **Metadata fields:** `sc.provider` → `sc.model_used`; `sc.model` → `sc.source` (update the two
   `val-provider` / `val-model` detail rows to show model-used / source; relabel the visible labels
   accordingly).
3. **Pending (202) safety:** guard the image render — if `sc.result === 'pending'` or `data.data` is empty,
   show a "generating — the backfill will build this shortly, check back" state instead of dereferencing
   `data.data[0].url`.
4. **Savings counter:** drive the running "$ saved" from `sc.cost_saved_usd` directly (the Worker already
   returns the correct value — nonzero for hit/approximate, zero for pending), rather than gating on
   `result === 'hit'`.
5. **Sizes (optional, low-priority):** `sc.sizes.{thumb,medium,large}` are available; keep using the
   top-level `data[0].url` (= large) for the main image. No required change beyond not crashing.

The key-generation and account UI already POST to the same-origin `/v1/keys/generate` and read/write
`localStorage`; no change needed once same-origin.

## 6. Testing

- **Worker unit tests (vitest):** the handler tests (`handler.test.ts`) are unaffected. Update
  `router.test.ts`: the fake `env` gains an `ASSETS` stub (`{ fetch: async () => new Response('<html>', {status:200}) }`);
  the "unknown route" test changes from expecting `404` to expecting the request delegated to
  `env.ASSETS.fetch` (assert the ASSETS response is returned); `/healthz`, `/v1/keys/generate`,
  `/v1/images/generations`, and the `401`/`202` cases stay as-is. Add a test that an unmatched `/v1/foo`
  still returns `404` (API semantics preserved). Target: worker suite green (≈ 33 tests).
- **Frontend JS:** no unit harness; correctness is verified by inspection + a live check
  (`cd projects/worker && npx wrangler dev`, load `/`, generate → see a badge + image or the pending
  state, generate a key). This is a live-verify step, noted in the runbook.

## 7. Deploy

`cd projects/worker && npm run deploy` ships the Worker **and** the `public/` assets in one deployment.
The Worker serves `/` (the SPA) and `/v1/*` from the same origin. Update the README's Worker section:
the site is served by the Worker (no separate Pages step); mention `wrangler dev` for local preview.

## 8. Open assumptions (correct if wrong)

- Static-assets dir is `projects/worker/public/` (not `assets/`).
- `run_worker_first = true` + delegating non-API requests to `env.ASSETS.fetch()` is the routing model
  (robust across wrangler versions); if a pinned wrangler lacks `run_worker_first`, bump the worker's
  `wrangler` devDependency to a Static-Assets-capable version.
- The frontend JS edits are localized to the response-handling function + a little badge CSS; no broader
  rewrite. The `WagmiPhotos`↔`SharedCache` branding split is out of scope here (tracked separately).
- `/v1/*` unmatched → `404`; all non-`/v1` unmatched paths → SPA via `env.ASSETS.fetch`.
