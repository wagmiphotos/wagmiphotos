# DEPLOY — going live

Ordered runbook for the first production deploy. Everything is verified offline
with fakes; nothing below has run against live infra yet. Run the steps **in
order** — several have hard dependencies (noted inline).

Prereqs: a Cloudflare account, a Backblaze B2 bucket, a GMI Cloud (CPU) box with
Docker, and a GMI Cloud generation API key. All commands are run from the repo
root unless a `cd` is shown.

---

## 0. Authenticate

```bash
cd projects/worker && npx wrangler login
```

## 1. Create D1 and wire its id

D1 does **not** exist yet — `wrangler.toml` still has a placeholder id.

```bash
npx wrangler d1 create sharedcache        # copy the database_id it prints
```

Edit `projects/worker/wrangler.toml` → replace `REPLACE_WITH_D1_DATABASE_ID`
(line ~9) with the id. (Ask Claude to make this edit if you paste the id.)

## 2. Create the Vectorize index

```bash
npx wrangler vectorize create sharedcache-clip --dimensions=768 --metric=cosine
```

## 3. Apply D1 migrations remotely — **BEFORE any deploy**

Migrations `0002` (`queries.generate`, backfill demand tracking) and `0003`
(assets browse index) must be live first. Deploying the Worker ahead of them
breaks demand tracking and **hard-errors the Python backfill**.

```bash
npx wrangler d1 migrations apply sharedcache --remote   # runs 0001 → 0002 → 0003
```

## 4. Stand up the GMI box (embedder + backfill + tunnel)

Full detail in `deploy/gmi/README.md`. Summary:

1. Provision a CPU GMI instance with Docker + Docker Compose.
2. Cloudflare dashboard → Zero Trust → Networks → Tunnels → create a tunnel,
   copy its token. Add public hostname `embed.wagmi.photos` →
   `http://embedder:8000`.
3. Clone the repo on the box; create `deploy/gmi/.env`:
   - `EMBED_TOKEN` — **mandatory**, any long random string (the embedder is
     public via the tunnel and fails closed without it). Reuse in step 6.
   - `TUNNEL_TOKEN` — from step 4.2.
   - `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DATABASE_ID` (from step 1),
     `VECTORIZE_INDEX_NAME=sharedcache-clip`, `GMICLOUD_API_KEY`,
     `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`, `B2_PUBLIC_URL_BASE`,
     `FLOOR_SIM_MAX=0.35`, `FLOOR_SIM_MIN=0.18`.
4. `cd deploy/gmi && docker compose up -d --build`
   (first build pulls CPU torch + ~1.7 GB CLIP weights — one time).

## 5. Give the Worker the embedder token

```bash
cd projects/worker
npx wrangler secret put CLIP_EMBED_TOKEN   # paste the SAME value as EMBED_TOKEN
```

## 6. Route the custom domains, then deploy

Route **both** `wagmi.photos` (site + API) and `api.wagmi.photos` (documented
API base) to this Worker in the Cloudflare dashboard, then:

```bash
npx wrangler deploy --dry-run   # confirm the output lists the RATE_LIMITER binding
npm run deploy
```

## 7. Seed the pool and tune the floor

```bash
uv run python -m sharedcache.backfill.seed_pd12m --limit 100
```

Then **tune** `FLOOR_SIM_MAX` / `FLOOR_SIM_MIN` against the seeded pool. CLIP
cross-modal (text→image) cosines run low, ~0.2–0.35 — the defaults (0.35 / 0.18)
are a starting guess, not calibrated.

**Open question to settle here:** confirm PD12M actually exposes precomputed CLIP
*image* vectors. If not, the seeder falls back to embedding captions (it refuses
to seed zero vectors) — cross-modal match quality will differ.

---

## Verify

```bash
curl https://embed.wagmi.photos/healthz          # embedder up
curl -s -X POST https://embed.wagmi.photos/embed/text \
  -H "Authorization: Bearer $EMBED_TOKEN" -H "Content-Type: application/json" \
  -d '{"inputs":"a fox"}' | head -c 80           # -> [[0.123, ...   (768 floats)
curl https://wagmi.photos/healthz                # worker up
# open https://wagmi.photos/  → SPA loads, #/library search works
# a POST /v1/images/generations returns a nearest image or 202 pending
docker compose logs backfill --tail 20           # (on the box) polling loop ticking
```

## Day 2

- Logs: `docker compose logs -f embedder|backfill|cloudflared`
- Update the box: `git pull && docker compose up -d --build`
- One-shot backfill for debugging: `docker compose run --rm backfill --once`

## Rollback

- Worker: `npx wrangler rollback` (or redeploy a prior commit).
- Migrations are forward-only — do not delete D1 data to "undo"; restore from a
  D1 export if needed.
