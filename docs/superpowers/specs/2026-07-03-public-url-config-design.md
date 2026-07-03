# Public URL configuration — design

**Date:** 2026-07-03
**Status:** Approved

## Purpose

The production site lives at `https://wagmi.photos` and the public API is
documented at `https://api.wagmi.photos/v1`. Both URLs must be configurable by
environment variable so a development deployment (e.g. `dev.wagmi.photos` /
`api.dev.wagmi.photos`) renders its own URLs without code changes.

## Topology (decided)

One worker, two custom domains: `wagmi.photos` and `api.wagmi.photos` both
route to this worker. Consequences:

- The SPA's own fetch calls stay **relative** (`/v1/...`) — they hit whichever
  origin serves the page, so playground/library work identically on
  `wrangler dev`, a dev deployment, and production. No CORS work.
- `api.wagmi.photos/v1` is the **documented** base URL for external
  developers; the env vars drive what the docs/examples display.

Out of scope: CORS headers, split site/API workers, an env-injected fetch
base for the SPA, OG/social meta tags.

## Configuration

`projects/worker/wrangler.toml` `[vars]` gains:

```toml
PUBLIC_SITE_URL = "https://wagmi.photos"
PUBLIC_API_BASE_URL = "https://api.wagmi.photos/v1"
```

`Env` in `src/types.ts` gains optional `PUBLIC_SITE_URL?: string` and
`PUBLIC_API_BASE_URL?: string`. Local dev overrides go in `.dev.vars`
(git-ignored); a dev deployment sets its own `[vars]`.

## HTML defaults

`public/index.html` ships the **production** URLs as literal text (correct
even if the rewrite never runs):

- Every displayed `https://wagmiphotos.dev/v1` becomes
  `https://api.wagmi.photos/v1` (home code panel, docs curl/keygen examples,
  OpenAI drop-in before/after + Python/JS/cURL, agents skill snippet —
  roughly 10 occurrences).
- Illustrative asset URLs `https://cdn.wagmiphotos.dev/...` become
  `https://cdn.wagmi.photos/...` (3 occurrences).
- `<head>` gains `<link rel="canonical" href="https://wagmi.photos/">`.

## Worker rewrite on serve

New `src/rewrite.ts` exporting:

```ts
export const DEFAULT_SITE_URL = "https://wagmi.photos";
export const DEFAULT_API_BASE_URL = "https://api.wagmi.photos/v1";
export async function rewritePublicUrls(res: Response, env: Env): Promise<Response>;
```

Behavior:

- If the response `Content-Type` does not include `text/html`, return `res`
  unchanged (body never consumed — assets stream through).
- Compute the replacement pairs: `DEFAULT_API_BASE_URL → env.PUBLIC_API_BASE_URL`
  and `DEFAULT_SITE_URL → env.PUBLIC_SITE_URL`, keeping only pairs where the
  env value is set, non-empty, and different from the default. If none
  remain, return `res` unchanged.
- Replace the API base **before** the site URL (`https://api.wagmi.photos/v1`
  contains no `https://wagmi.photos` substring, but the ordering is fixed to
  keep the operation deterministic).
- Otherwise `await res.text()`, `replaceAll` each pair, and return a new
  `Response(text, { status, statusText, headers })` with the original headers
  minus `Content-Length` (the length changed; let the runtime recompute).

Wiring in `src/index.ts`: the ASSETS fallback becomes
`return rewritePublicUrls(await env.ASSETS.fetch(request), env);`.
Plain `String.replaceAll` — no HTMLRewriter — so the existing node-based
vitest suite can exercise it.

## Testing

New `test/rewrite.test.ts` (unit) plus one router-level test:

- HTML response + both vars overridden → both URL families replaced in body.
- Vars unset, or equal to the defaults → the exact same Response object comes
  back (body not consumed).
- Non-HTML response (`image/webp`) + overridden vars → untouched.
- Rewritten response drops the stale `Content-Length` header.
- Router test: `GET /` with `fakeEnv` ASSETS returning HTML containing
  `https://api.wagmi.photos/v1` and `PUBLIC_API_BASE_URL` overridden →
  body contains the override, not the default.

## Documentation

`HANDOFF.md` deploy section: both custom domains route to the worker; the two
`[vars]`; `.dev.vars` for local overrides; note that docs/examples display
these values via the serve-time rewrite.
