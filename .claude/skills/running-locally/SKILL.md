---
name: running-locally
description: Use when asked to run, start, serve, or locally test the SharedCache / wagmi.photos app — the Cloudflare Worker and its playground SPA (projects/worker). Covers the local wrangler dev boot, the demo library seed, and why the generation path can't run offline.
---

# Running SharedCache locally

## Overview

"The app" is the **Cloudflare Worker + playground SPA** in `projects/worker` (the
edge request path for wagmi.photos). Run it with `wrangler dev` in **local mode**
(Miniflare). Local mode serves the SPA and the D1-backed endpoints fully offline;
the semantic-match / **generation path cannot run locally** (see below).

The Python side (`projects/backfill`, `projects/embedder`) is not "the app" — it's
the batch worker. Run those only if the task is specifically about them.

## Quick start

All commands run from `projects/worker` unless noted. `node_modules` and a local
D1 are usually already present; the migrate + seed steps are idempotent, so running
them again is harmless (and required on a fresh checkout — `.wrangler/` is gitignored).

```bash
cd projects/worker
npm install                                            # only if node_modules/ is missing
npx wrangler d1 migrations apply sharedcache --local   # creates the D1 schema
npx wrangler d1 execute sharedcache --local \          # seed the demo library
  --file ../../.claude/skills/running-locally/seed-demo.sql
npx wrangler dev --local --port 8787 --ip 127.0.0.1    # long-running; start in background
```

Server comes up at **http://127.0.0.1:8787**. Poll readiness without a bare sleep:

```bash
curl -s --retry 30 --retry-delay 1 --retry-connrefused http://127.0.0.1:8787/healthz
# → {"status":"ok"}
```

## What works offline vs. not

| Surface | Route / endpoint | Local? |
|---|---|---|
| Landing page + playground SPA | `/`, `/#/playground`, `/#/pricing` | ✅ |
| Library browse (renders seeded images) | `/#/library`, `GET /v1/library` | ✅ (needs the seed) |
| API-key issue | `POST /v1/keys/generate` | ✅ |
| Health | `GET /healthz` | ✅ |
| GitHub star badge | `GET /v1/meta/stars` | ✅ (returns `{"stars":null}` offline) |
| **Image generation / semantic match** | `POST /v1/images/generations` | ❌ **502** |

**Why generation 502s locally** — two infra deps with no local substitute:
1. **Cloudflare Vectorize has no local emulation.** wrangler prints *"Vectorize local
   bindings are not supported yet"*; `s.vectorize.query()` fails.
2. **The CLIP embedder isn't reachable.** `clipTextEmbed` fetches
   `CLIP_TEXT_EMBED_URL` (`embed.wagmi.photos`); offline / pre-deploy that's a DNS
   failure. The Worker maps both to a 502 `{"error":"upstream error","detail":"…"}`.

To exercise generation you need the deployed backend, not local mode: either follow
`DEPLOY.md`, or `wrangler dev --remote --experimental-vectorize-bind-to-prod` after
setting a real `database_id` in `wrangler.toml`, a live+seeded Vectorize index, and a
reachable `CLIP_TEXT_EMBED_URL` + `CLIP_EMBED_TOKEN` secret.

## Drive & verify (don't just boot it)

Smoke the working paths, then look at the UI:

```bash
curl -s "http://127.0.0.1:8787/v1/library?limit=4"     # 4 demo images
curl -s -X POST http://127.0.0.1:8787/v1/keys/generate # → {"key":"sc-…"}
```

Then open **http://127.0.0.1:8787/#/library** in a browser (or Playwright) and
confirm the four demo images actually render — they're served from the Worker's
own `public/assets/*.webp`, so a blank grid means the seed didn't land, not a
network problem. `/#/playground` renders the full generator UI (prompt, tolerance
slider, generate-on-miss toggle); clicking **Generate image** will 502 as above.

## Common mistakes

- **Empty library / blank grid** → the seed step was skipped or hit a fresh
  `.wrangler/` state. Re-run the `d1 execute … seed-demo.sql` line; it's idempotent.
- **Serving on a non-8787 port** → the seed's image URLs are absolute to `:8787`, so
  on any other port the library grid renders **blank** (the `<img>` src still points at
  8787, and nothing is listening there). If you must change the port, update it in
  `seed-demo.sql` too. Keep the URLs absolute — a Worker `fetch()` rejects relative
  URLs, so relative paths would break the `/v1/library/:id/download` proxy even though
  they'd fix the grid.
- **Reaching for `--remote` to "make generation work"** → that needs Cloudflare
  auth + a real `database_id` + a seeded Vectorize index. It's the deploy path, not
  a local convenience. Don't wire it up unless the task is a live deploy.
- **`compatibility_date` warning** (runtime older than `2026-06-01`) is harmless.
