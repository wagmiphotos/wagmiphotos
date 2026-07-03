# Public URL Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Env-configurable public URLs — site `https://wagmi.photos`, documented API base `https://api.wagmi.photos/v1` — rendered into the served SPA so dev deployments show their own URLs.

**Architecture:** One worker serves both domains. The HTML ships production URLs as literal defaults; a new `src/rewrite.ts` string-replaces them at serve time when `PUBLIC_SITE_URL` / `PUBLIC_API_BASE_URL` env vars differ from the defaults. The SPA's own fetch calls stay relative — no CORS, dev works unchanged.

**Tech Stack:** Cloudflare Workers (wrangler 3), TypeScript, vitest (plain node — no HTMLRewriter), single-file SPA in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-07-03-public-url-config-design.md`

## Global Constraints

- All work in `projects/worker/`; tests via `npm test` from there; suite currently 63/63 and must stay green.
- Exact default values: `DEFAULT_SITE_URL = "https://wagmi.photos"`, `DEFAULT_API_BASE_URL = "https://api.wagmi.photos/v1"`.
- The SPA's runtime fetch calls stay relative (`/v1/...`) — do not introduce an absolute fetch base.
- Non-HTML asset responses must pass through with their body unconsumed.
- Brand copy is `wagmi.photos` lowercase, never `WagmiPhotos`.
- Working branch: `feat/library-page`.

---

### Task 1: Serve-time URL rewrite module

**Files:**
- Create: `projects/worker/src/rewrite.ts`
- Modify: `projects/worker/src/types.ts` (Env), `projects/worker/src/index.ts` (ASSETS fallback), `projects/worker/wrangler.toml` ([vars])
- Test: `projects/worker/test/rewrite.test.ts` (new), `projects/worker/test/router.test.ts`

**Interfaces:**
- Consumes: `Env` from `src/types.ts`; the ASSETS fallback in `src/index.ts` (currently `return env.ASSETS.fetch(request);` just before the outer catch).
- Produces: `DEFAULT_SITE_URL: string`, `DEFAULT_API_BASE_URL: string`, and `rewritePublicUrls(res: Response, env: Env): Promise<Response>` exported from `src/rewrite.ts`; `Env.PUBLIC_SITE_URL?: string` and `Env.PUBLIC_API_BASE_URL?: string`.

- [ ] **Step 1: Write the failing tests**

Create `projects/worker/test/rewrite.test.ts`:

```ts
import { it, expect } from "vitest";
import { rewritePublicUrls, DEFAULT_API_BASE_URL, DEFAULT_SITE_URL } from "../src/rewrite";
import type { Env } from "../src/types";

function envWith(over: Partial<Env> = {}): Env {
  return { DB: null, VECTORIZE: null, CLIP_TEXT_EMBED_URL: "", ASSETS: { fetch: async () => new Response("") }, ...over } as Env;
}

function htmlRes(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-length": String(body.length) } });
}

it("rewrites both URL families when vars differ from defaults", async () => {
  const body = `<a href="${DEFAULT_API_BASE_URL}/images/generations">x</a><link rel="canonical" href="${DEFAULT_SITE_URL}/">`;
  const res = await rewritePublicUrls(htmlRes(body), envWith({
    PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1",
    PUBLIC_SITE_URL: "https://dev.wagmi.photos",
  }));
  const text = await res.text();
  expect(text).toContain("https://api.dev.wagmi.photos/v1/images/generations");
  expect(text).toContain('href="https://dev.wagmi.photos/"');
  expect(text).not.toContain(DEFAULT_API_BASE_URL);
});

it("returns the same response object when vars are unset or equal to defaults", async () => {
  const r1 = htmlRes("x");
  expect(await rewritePublicUrls(r1, envWith())).toBe(r1);
  const r2 = htmlRes("x");
  expect(await rewritePublicUrls(r2, envWith({
    PUBLIC_API_BASE_URL: DEFAULT_API_BASE_URL, PUBLIC_SITE_URL: DEFAULT_SITE_URL,
  }))).toBe(r2);
});

it("never touches non-HTML responses", async () => {
  const res = new Response("BYTES", { status: 200, headers: { "content-type": "image/webp" } });
  const out = await rewritePublicUrls(res, envWith({ PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1" }));
  expect(out).toBe(res);
  expect(res.bodyUsed).toBe(false);
});

it("drops the stale Content-Length header on rewrite", async () => {
  const res = await rewritePublicUrls(htmlRes(DEFAULT_API_BASE_URL), envWith({ PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1" }));
  expect(res.headers.get("content-length")).toBeNull();
  expect(await res.text()).toBe("https://api.dev.wagmi.photos/v1");
});
```

Append to `projects/worker/test/router.test.ts`:

```ts
it("serves SPA HTML with env-configured public URLs substituted", async () => {
  const env = fakeEnv({
    ASSETS: { fetch: async () => new Response('<a href="https://api.wagmi.photos/v1">docs</a>', { status: 200, headers: { "content-type": "text/html" } }) },
    PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1",
  });
  const res = await worker.fetch(new Request("https://x/"), env);
  expect(await res.text()).toBe('<a href="https://api.dev.wagmi.photos/v1">docs</a>');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npm test -- rewrite.test.ts router.test.ts`
Expected: rewrite tests FAIL (`Cannot find module '../src/rewrite'`); the new router test FAILS (body still contains the default URL); existing router tests pass.

- [ ] **Step 3: Add the Env fields**

In `projects/worker/src/types.ts`, inside `interface Env`, after the `GITHUB_REPO?: string;` line add:

```ts
  PUBLIC_SITE_URL?: string; PUBLIC_API_BASE_URL?: string;
```

- [ ] **Step 4: Implement the rewrite module**

Create `projects/worker/src/rewrite.ts`:

```ts
import type { Env } from "./types";

export const DEFAULT_SITE_URL = "https://wagmi.photos";
export const DEFAULT_API_BASE_URL = "https://api.wagmi.photos/v1";

/**
 * Swap the canonical public URLs baked into the SPA for env-configured ones,
 * so dev/staging deployments render their own site and API base URLs.
 * HTML only; anything else streams through untouched.
 */
export async function rewritePublicUrls(res: Response, env: Env): Promise<Response> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return res;

  // API base first — fixed order keeps the substitution deterministic.
  const pairs: [string, string][] = [];
  if (env.PUBLIC_API_BASE_URL && env.PUBLIC_API_BASE_URL !== DEFAULT_API_BASE_URL) {
    pairs.push([DEFAULT_API_BASE_URL, env.PUBLIC_API_BASE_URL]);
  }
  if (env.PUBLIC_SITE_URL && env.PUBLIC_SITE_URL !== DEFAULT_SITE_URL) {
    pairs.push([DEFAULT_SITE_URL, env.PUBLIC_SITE_URL]);
  }
  if (pairs.length === 0) return res;

  let text = await res.text();
  for (const [from, to] of pairs) text = text.replaceAll(from, to);
  const headers = new Headers(res.headers);
  headers.delete("content-length"); // length changed; let the runtime recompute
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}
```

- [ ] **Step 5: Wire it into the ASSETS fallback**

In `projects/worker/src/index.ts`, add to the imports:

```ts
import { rewritePublicUrls } from "./rewrite";
```

Replace the ASSETS fallback line

```ts
      return env.ASSETS.fetch(request);
```

with:

```ts
      return await rewritePublicUrls(await env.ASSETS.fetch(request), env);
```

- [ ] **Step 6: Add the wrangler vars**

In `projects/worker/wrangler.toml`, inside the existing `[vars]` block (after the `IMAGE_PRICE_USD` line), add:

```toml
PUBLIC_SITE_URL = "https://wagmi.photos"           # canonical site origin (override per environment / .dev.vars)
PUBLIC_API_BASE_URL = "https://api.wagmi.photos/v1"  # documented API base rendered into docs/examples
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd projects/worker && npm test -- rewrite.test.ts router.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite and commit**

Run: `cd projects/worker && npm test` — expected 68 passed (63 + 5 new). Then:

```bash
git add projects/worker/src/rewrite.ts projects/worker/src/types.ts projects/worker/src/index.ts projects/worker/wrangler.toml projects/worker/test/rewrite.test.ts projects/worker/test/router.test.ts
git commit -m "feat(worker): env-configurable public site/API URLs via serve-time rewrite"
```

---

### Task 2: Canonical URLs in the SPA + deploy docs

**Files:**
- Modify: `projects/worker/public/index.html`, `HANDOFF.md`, `.gitignore`

**Interfaces:**
- Consumes: the serve-time rewrite from Task 1 (defaults `https://wagmi.photos` / `https://api.wagmi.photos/v1`).
- Produces: HTML whose displayed URLs are exactly those defaults, so the rewrite has the right anchor text to substitute.

- [ ] **Step 1: Swap the displayed URLs**

In `projects/worker/public/index.html`, apply two global replacements (each has ~10 and 3 occurrences respectively — use replace-all, not per-line edits):

1. `https://wagmiphotos.dev/v1` → `https://api.wagmi.photos/v1`
   (home code panel curl/Python/JS, docs keygen + generations curl examples, docs "pointing base_url at" note, OpenAI drop-in before/after + Python/JS/cURL, agents skill snippet)
2. `https://cdn.wagmiphotos.dev` → `https://cdn.wagmi.photos`
   (illustrative response-sample asset URLs)

- [ ] **Step 2: Add the canonical link**

In the `<head>`, directly after the favicon line
`<link rel="icon" type="image/png" sizes="64x64" href="/assets/favicon.png">` add:

```html
  <link rel="canonical" href="https://wagmi.photos/">
```

- [ ] **Step 3: Verify no stale domain remains**

Run: `grep -c 'wagmiphotos.dev' projects/worker/public/index.html`
Expected: `0`

Run: `grep -c 'api.wagmi.photos/v1' projects/worker/public/index.html`
Expected: ≥ 10 (roughly 13 with cdn/canonical counted separately; any non-zero double-digit count is fine)

- [ ] **Step 4: Verify in the running app**

With the dev server on port 8787 (check `curl -s http://localhost:8787/healthz`; wrangler hot-reloads):

1. `curl -s http://localhost:8787/ | grep -c 'api.wagmi.photos/v1'` → non-zero (defaults served verbatim when no override is set — correct: docs always show the canonical API base).
2. `curl -s http://localhost:8787/assets/match-flamingo.webp -o /dev/null -w '%{http_code} %{content-type}\n'` → `200 image/webp` (binary assets untouched by the rewrite path).

- [ ] **Step 5: Update HANDOFF.md**

In `HANDOFF.md`, find the deploy/runbook section (it already documents `wrangler d1 migrations apply` and `npm run deploy`). Add a short subsection:

```markdown
### Domains & public URLs

- Route BOTH custom domains to this worker: `wagmi.photos` (site + API) and
  `api.wagmi.photos` (documented API base for external developers).
- `[vars]` `PUBLIC_SITE_URL` / `PUBLIC_API_BASE_URL` hold the canonical URLs.
  The SPA ships them as defaults; the worker substitutes overrides at serve
  time (`src/rewrite.ts`), so a dev deployment (e.g. `dev.wagmi.photos` /
  `api.dev.wagmi.photos`) renders its own URLs in docs and examples.
- Local overrides go in `projects/worker/.dev.vars` (git-ignored). The SPA's
  own requests are origin-relative, so local dev needs no configuration.
```

Match the file's existing heading levels and tone.

Also add `.dev.vars` to the repo-root `.gitignore` (it is referenced as the
local-override mechanism and may hold secrets), in the "Node / Cloudflare
Worker" section:

```
.dev.vars
```

- [ ] **Step 6: Run the full suite and commit**

Run: `cd projects/worker && npm test` — expected all pass (HTML/docs changes can't affect it; this guards against accidents). Then:

```bash
git add projects/worker/public/index.html HANDOFF.md .gitignore
git commit -m "feat(site): canonical wagmi.photos URLs in examples + domain deploy docs"
```
