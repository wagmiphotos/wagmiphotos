# GMI embedder + backfill deployment — design

**Date:** 2026-07-03
**Status:** Approved (topology confirmed by Joris: one GMI box; Cloudflare
Containers evaluated and set aside for now — skinny beta CPU, cold starts,
and it would split the CLIP model across two serving stacks)

## Purpose

Give the system a live CLIP ViT-L/14 embedding endpoint — the one missing
piece for real traffic — and a production home for the backfill worker, as a
single deployment on one GMI Cloud box. The Worker's hot path gets text
embeddings over a Cloudflare Tunnel; the backfill gets text+image embeddings
over the compose-internal network.

## Decisions

- **One CPU GMI box**, one compose stack, three services: `embedder`,
  `backfill` (existing image, unchanged code), `cloudflared`.
- **Exposure via Cloudflare Tunnel** as `embed.wagmi.photos` — no open ports,
  TLS by Cloudflare. Only the Worker uses the public hostname; the backfill
  calls `http://embedder:8000` directly.
- **Protocol is frozen to what the clients already speak** (`src/embed.ts`,
  `common/clip.py`): no changes to either client.
- Model: **open_clip `ViT-L-14` / `openai` weights**, CPU inference, raw
  (unnormalized) features — Vectorize uses cosine, so normalization is
  irrelevant, and raw matches the PD12M convention.
- Weights are **baked into the Docker image at build time** (immutable image,
  fast startup, no runtime egress); the image is large, which is acceptable
  for a single box.

## New package: `projects/embedder/` (`sharedcache-embedder`)

Standalone uv-workspace member (no dependency on `sharedcache-common`).
FastAPI app with an injectable encoder so tests never load the real model:

- `model.py` — `ClipEncoder` protocol (`encode_text(text: str) -> list[float]`,
  `encode_image(image_bytes: bytes) -> list[float]`) and `OpenClipEncoder`
  implementing it with open_clip + Pillow, loaded once.
- `app.py` — `create_app(encoder, token: str | None) -> FastAPI`:
  - `GET /healthz` → `{"status": "ok"}`, unauthenticated.
  - `POST /embed/text`, JSON `{"inputs": "<text>"}` → `[[768 floats]]`
    (HF-style nested list — both clients flatten it). Missing/empty
    `inputs` → 422.
  - `POST /embed/image`, raw image bytes body → `[[768 floats]]`.
    Undecodable bytes → 422.
  - If `token` is set, both embed routes require
    `Authorization: Bearer <token>`; wrong/missing → 401. `healthz` stays
    open (tunnel/compose health checks).
- `__main__.py` — builds `OpenClipEncoder` from env (`EMBED_MODEL` default
  `ViT-L-14`, `EMBED_PRETRAINED` default `openai`, `EMBED_TOKEN` optional)
  and serves with uvicorn on `0.0.0.0:8000`.
- `Dockerfile` — `python:3.11-slim`, CPU-only torch wheels, weights
  pre-downloaded at build via a tiny script that instantiates the model.
- Tests (offline, fake encoder injected via `create_app`): response shapes,
  auth on/off, 401/422 paths, healthz. No network, no model download.

## Deploy bundle: `deploy/gmi/`

- `docker-compose.yml` — services:
  - `embedder`: built from the repo, `EMBED_TOKEN` from env, healthcheck on
    `/healthz`, internal port 8000 (not published on the host).
  - `backfill`: existing `projects/backfill/Dockerfile`, `env_file: .env`,
    with `CLIP_TEXT_EMBED_URL=http://embedder:8000/embed/text`,
    `CLIP_IMAGE_EMBED_URL=http://embedder:8000/embed/image`,
    `CLIP_EMBED_TOKEN=${EMBED_TOKEN}`; `depends_on` embedder healthy.
  - `cloudflared`: `cloudflare/cloudflared`, `tunnel run --token
    ${TUNNEL_TOKEN}`; the tunnel's public hostname `embed.wagmi.photos`
    routes to `http://embedder:8000` (configured in the Cloudflare
    dashboard when creating the tunnel).
- `deploy/gmi/README.md` — the box runbook (see HANDOFF below; this file
  holds the copy-paste commands).

## Wiring

- `projects/worker/wrangler.toml` `[vars]`:
  `CLIP_TEXT_EMBED_URL = "https://embed.wagmi.photos/embed/text"`.
  Token via `wrangler secret put CLIP_EMBED_TOKEN` (already supported).
- `.env.example`: set the two `CLIP_*_EMBED_URL` entries to the internal
  compose values, add `EMBED_TOKEN=` and `TUNNEL_TOKEN=` with one-line
  comments.
- `HANDOFF.md`: new "GMI box (embedder + backfill)" subsection in the deploy
  section — provision CPU box → install docker → create tunnel + DNS
  (`embed.wagmi.photos` → `http://embedder:8000`) → fill `.env` →
  `docker compose up -d --build` → set Worker var + secret → seed → tune
  `FLOOR_SIM_*`.

## Testing

- `projects/embedder/tests/` via the root uv workspace (`uv run pytest`
  from `projects/embedder`), fully offline.
- `docker compose -f deploy/gmi/docker-compose.yml config` validates the
  stack shape in CI-less environments.
- Existing worker (69) and common (23) suites stay green; the wrangler var
  change is config-only.

## Out of scope

- Prompt→embedding caching in the Worker (follow-up).
- GPU serving, autoscaling, Cloudflare Containers migration (revisit when
  traffic or container maturity justifies).
- Backfill code changes of any kind.
