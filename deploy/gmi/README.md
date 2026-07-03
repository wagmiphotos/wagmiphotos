# GMI box — embedder + backfill

One CPU instance runs three containers: the CLIP ViT-L/14 embedding service,
the demand-ranked backfill worker, and a Cloudflare Tunnel that publishes the
embedder as `embed.wagmi.photos` (no open ports on the box).

## One-time setup

1. Provision a CPU-capable GMI instance with Docker + Docker Compose.
2. Cloudflare dashboard → Zero Trust → Networks → Tunnels → create a tunnel,
   copy its token. Add a public hostname: `embed.wagmi.photos` →
   `http://embedder:8000`.
3. Clone the repo on the box and create `deploy/gmi/.env`:

   ```
   # embedder auth (any long random string; also set as the Worker secret)
   EMBED_TOKEN=
   # cloudflare tunnel token from step 2
   TUNNEL_TOKEN=
   # backfill needs the same variables as the repo-root .env.example:
   CF_ACCOUNT_ID=
   CF_API_TOKEN=
   D1_DATABASE_ID=
   VECTORIZE_INDEX_NAME=sharedcache-clip
   GMICLOUD_API_KEY=
   B2_KEY_ID=
   B2_APP_KEY=
   B2_BUCKET=
   B2_REGION=us-west-004
   B2_PUBLIC_URL_BASE=
   FLOOR_SIM_MAX=0.35
   FLOOR_SIM_MIN=0.18
   ```

4. `cd deploy/gmi && docker compose up -d --build`
   (first build downloads CPU torch + ~1.7 GB of CLIP weights — one time).

## Point the Worker at it

```
cd projects/worker
npx wrangler secret put CLIP_EMBED_TOKEN   # paste EMBED_TOKEN
npm run deploy                             # picks up CLIP_TEXT_EMBED_URL from wrangler.toml
```

## Verify

```
curl https://embed.wagmi.photos/healthz
curl -s -X POST https://embed.wagmi.photos/embed/text \
  -H "Authorization: Bearer $EMBED_TOKEN" -H "Content-Type: application/json" \
  -d '{"inputs":"a fox"}' | head -c 80        # -> [[0.123, ...   (768 floats)
docker compose logs backfill --tail 20        # polling loop ticking
```

## Day 2

- `docker compose logs -f embedder|backfill|cloudflared`
- Update: `git pull && docker compose up -d --build`
- The backfill runs in loop mode; one-shot debugging:
  `docker compose run --rm backfill --once`
