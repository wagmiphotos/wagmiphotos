# GMI box — backfill worker

One CPU instance runs the demand-ranked backfill worker. It loads the BGE
text embedding model (`BAAI/bge-base-en-v1.5`) in-process — no separate
embedding service or tunnel to run.

## One-time setup

1. Provision a CPU-capable GMI instance with Docker + Docker Compose.
2. Clone the repo on the box and create `deploy/gmi/.env`:

   ```
   # backfill needs the same variables as the repo-root .env.example:
   CF_ACCOUNT_ID=
   CF_API_TOKEN=
   D1_DATABASE_ID=
   VECTORIZE_INDEX_PREFIX=wagmiphotos-bge-
   VECTORIZE_SHARDS=3
   GMICLOUD_API_KEY=
   B2_KEY_ID=
   B2_APP_KEY=
   B2_BUCKET=
   B2_REGION=us-west-004
   B2_PUBLIC_URL_BASE=
   ```
   (Similarity floors are deliberately absent: the `contract.json`-pinned
   defaults rule, and env values would silently override them.)

3. `cd deploy/gmi && docker compose up -d --build`
   (first build downloads CPU torch + the BGE model weights — one time).

## Verify

```
docker compose logs backfill --tail 20        # polling loop ticking
```

## Day 2

- `docker compose logs -f backfill`
- Update: `git pull && docker compose up -d --build`
- The backfill runs in loop mode; one-shot debugging:
  `docker compose run --rm backfill --once`
