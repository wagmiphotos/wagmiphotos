# GMI Embedder + Backfill Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLIP ViT-L/14 embedding microservice plus a one-box GMI deployment bundle (embedder + backfill + Cloudflare Tunnel), wired into the Worker and documented.

**Architecture:** New standalone uv-workspace package `projects/embedder/` (FastAPI, injectable encoder, model deps behind an optional extra so the workspace and tests stay torch-free). A `deploy/gmi/docker-compose.yml` runs embedder + existing backfill image + cloudflared; the tunnel publishes `embed.wagmi.photos` for the Worker while the backfill uses the compose-internal hostname.

**Tech Stack:** Python 3.11, FastAPI/uvicorn, open_clip_torch (CPU), uv workspace, Docker Compose, Cloudflare Tunnel.

**Spec:** `docs/superpowers/specs/2026-07-03-gmi-embedder-deployment-design.md`

## Global Constraints

- Protocol is frozen to what `projects/worker/src/embed.ts` and `projects/common/src/sharedcache/common/clip.py` already send/parse: `POST /embed/text` JSON `{"inputs": "<text>"}`; `POST /embed/image` raw bytes; responses are HF-style nested `[[768 floats]]`; optional `Authorization: Bearer <token>`. NO changes to either client.
- Model: open_clip `ViT-L-14`, pretrained `openai`, CPU, raw (unnormalized) features.
- Tests must run fully offline — the real model is never loaded in tests; `uv sync` for the workspace must NOT pull torch (model deps live in the `model` optional extra, imported lazily).
- Public hostname: `https://embed.wagmi.photos`; internal compose hostname: `http://embedder:8000`.
- Existing suites stay green: worker vitest 69/69 (`npm test` from projects/worker), python `uv run pytest` (23 common + others) — run from repo root after workspace changes.
- Backfill code is untouched (only compose-level env).
- Working branch: `feat/gmi-embedder` (already created).

---

### Task 1: `sharedcache-embedder` package (app + offline tests)

**Files:**
- Create: `projects/embedder/pyproject.toml`
- Create: `projects/embedder/src/sharedcache/embedder/__init__.py` (empty)
- Create: `projects/embedder/src/sharedcache/embedder/model.py`
- Create: `projects/embedder/src/sharedcache/embedder/app.py`
- Create: `projects/embedder/src/sharedcache/embedder/__main__.py`
- Modify: `pyproject.toml` (repo root — workspace members, testpaths, dev deps)
- Test: `projects/embedder/tests/test_app.py`

**Interfaces:**
- Produces: `create_app(encoder, token: str | None = None) -> FastAPI` (app.py); `ClipEncoder` protocol with `encode_text(text: str) -> list[float]` / `encode_image(image_bytes: bytes) -> list[float]` and `OpenClipEncoder(model_name="ViT-L-14", pretrained="openai", device="cpu")` (model.py); `python -m sharedcache.embedder` entrypoint reading `EMBED_MODEL`, `EMBED_PRETRAINED`, `EMBED_TOKEN`, `PORT`.
- Consumes: nothing from other packages (standalone by design).

- [ ] **Step 1: Package scaffolding**

Create `projects/embedder/pyproject.toml`:

```toml
[project]
name = "sharedcache-embedder"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.115", "uvicorn>=0.30"]

[project.optional-dependencies]
# Real model serving only — keeps the uv workspace and tests torch-free.
model = ["open-clip-torch>=2.24", "torch>=2.4", "pillow>=10"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
[tool.hatch.build.targets.wheel]
packages = ["src/sharedcache"]
```

Create empty `projects/embedder/src/sharedcache/embedder/__init__.py`.

In the repo-root `pyproject.toml`, change the three lists:

```toml
[tool.uv.workspace]
members = ["projects/common", "projects/generation", "projects/backfill", "projects/embedder"]

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.24", "httpx>=0.27"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["projects/common/tests", "projects/generation/tests", "projects/backfill/tests", "projects/embedder/tests"]
```

(`httpx` is needed by FastAPI's `TestClient`; it was previously only a transitive dep via sharedcache-common.)

Run: `uv sync` from the repo root. Expected: succeeds WITHOUT installing torch/open-clip (they're behind the extra).

- [ ] **Step 2: Write the failing tests**

Create `projects/embedder/tests/test_app.py`:

```python
from fastapi.testclient import TestClient

from sharedcache.embedder.app import create_app


class FakeEncoder:
    """Deterministic encoder; raises ValueError for undecodable input like the real one."""
    def encode_text(self, text: str) -> list[float]:
        return [1.0, 2.0, 3.0]

    def encode_image(self, image_bytes: bytes) -> list[float]:
        if image_bytes == b"not-an-image":
            raise ValueError("undecodable image")
        return [4.0, 5.0, 6.0]


def client(token=None):
    return TestClient(create_app(FakeEncoder(), token=token))


def test_healthz_open_even_with_token():
    r = client(token="s3cret").get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_text_embed_returns_nested_vector():
    r = client().post("/embed/text", json={"inputs": "a fox"})
    assert r.status_code == 200
    assert r.json() == [[1.0, 2.0, 3.0]]


def test_image_embed_returns_nested_vector():
    r = client().post("/embed/image", content=b"png-bytes")
    assert r.status_code == 200
    assert r.json() == [[4.0, 5.0, 6.0]]


def test_token_required_when_configured():
    c = client(token="s3cret")
    assert c.post("/embed/text", json={"inputs": "x"}).status_code == 401
    assert c.post("/embed/text", json={"inputs": "x"},
                  headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert c.post("/embed/image", content=b"x").status_code == 401
    ok = c.post("/embed/text", json={"inputs": "x"},
                headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_no_token_means_open_access():
    assert client().post("/embed/text", json={"inputs": "x"}).status_code == 200


def test_text_input_validation():
    c = client()
    assert c.post("/embed/text", json={}).status_code == 422
    assert c.post("/embed/text", json={"inputs": 7}).status_code == 422
    assert c.post("/embed/text", json={"inputs": "   "}).status_code == 422
    assert c.post("/embed/text", content=b"not json",
                  headers={"Content-Type": "application/json"}).status_code == 422


def test_image_input_validation():
    c = client()
    assert c.post("/embed/image", content=b"").status_code == 422
    assert c.post("/embed/image", content=b"not-an-image").status_code == 422
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest projects/embedder/tests -q` (repo root)
Expected: FAIL — `ModuleNotFoundError`/import error for `sharedcache.embedder.app`.

- [ ] **Step 4: Implement model.py**

Create `projects/embedder/src/sharedcache/embedder/model.py`:

```python
from typing import Protocol


class ClipEncoder(Protocol):
    def encode_text(self, text: str) -> list[float]: ...
    def encode_image(self, image_bytes: bytes) -> list[float]: ...


class OpenClipEncoder:
    """CLIP over open_clip. Heavy deps (torch/open_clip/PIL) are imported lazily
    so the module is importable — and the app testable — without the `model` extra."""

    def __init__(self, model_name: str = "ViT-L-14", pretrained: str = "openai", device: str = "cpu"):
        import open_clip
        import torch
        self._torch = torch
        self._model, _, self._preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained
        )
        self._model.eval().to(device)
        self._tokenizer = open_clip.get_tokenizer(model_name)
        self._device = device

    def encode_text(self, text: str) -> list[float]:
        with self._torch.no_grad():
            tokens = self._tokenizer([text]).to(self._device)
            return self._model.encode_text(tokens)[0].tolist()

    def encode_image(self, image_bytes: bytes) -> list[float]:
        from io import BytesIO
        from PIL import Image
        try:
            img = Image.open(BytesIO(image_bytes)).convert("RGB")
        except Exception as e:
            raise ValueError(f"undecodable image: {e}") from e
        with self._torch.no_grad():
            tensor = self._preprocess(img).unsqueeze(0).to(self._device)
            return self._model.encode_image(tensor)[0].tolist()
```

- [ ] **Step 5: Implement app.py**

Create `projects/embedder/src/sharedcache/embedder/app.py`:

```python
from fastapi import FastAPI, HTTPException, Request

from .model import ClipEncoder


def create_app(encoder: ClipEncoder, token: str | None = None) -> FastAPI:
    app = FastAPI(title="sharedcache-embedder", docs_url=None, redoc_url=None)

    def check_auth(request: Request) -> None:
        if token and request.headers.get("authorization") != f"Bearer {token}":
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.post("/embed/text")
    async def embed_text(request: Request):
        check_auth(request)
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=422, detail="body must be JSON")
        inputs = body.get("inputs") if isinstance(body, dict) else None
        if not isinstance(inputs, str) or not inputs.strip():
            raise HTTPException(status_code=422, detail="inputs must be a non-empty string")
        return [encoder.encode_text(inputs)]

    @app.post("/embed/image")
    async def embed_image(request: Request):
        check_auth(request)
        data = await request.body()
        if not data:
            raise HTTPException(status_code=422, detail="empty body")
        try:
            return [encoder.encode_image(data)]
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))

    return app
```

- [ ] **Step 6: Implement __main__.py**

Create `projects/embedder/src/sharedcache/embedder/__main__.py`:

```python
import os

import uvicorn

from .app import create_app
from .model import OpenClipEncoder


def main() -> None:
    encoder = OpenClipEncoder(
        model_name=os.environ.get("EMBED_MODEL", "ViT-L-14"),
        pretrained=os.environ.get("EMBED_PRETRAINED", "openai"),
    )
    app = create_app(encoder, token=os.environ.get("EMBED_TOKEN") or None)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv sync && uv run pytest projects/embedder/tests -q`
Expected: 8 passed, no torch installed (verify: `uv run python -c "import torch"` should FAIL with ModuleNotFoundError).

- [ ] **Step 8: Run the full python suite and commit**

Run: `uv run pytest -q` (repo root) — expected: all pass (previous suites + 8 new).

```bash
git add pyproject.toml uv.lock projects/embedder
git commit -m "feat(embedder): CLIP embedding service package with offline-testable app"
```

---

### Task 2: Docker image + `deploy/gmi` compose bundle

**Files:**
- Create: `projects/embedder/Dockerfile`
- Create: `deploy/gmi/docker-compose.yml`
- Create: `deploy/gmi/README.md`
- Modify: `projects/backfill/Dockerfile` (add the new workspace member to its COPY set — `uv sync --frozen` fails if a declared member is missing from the build context)
- Modify: `.gitignore` (ignore `deploy/gmi/.env` is already covered by the global `.env` pattern — verify, don't duplicate)

**Interfaces:**
- Consumes: Task 1's package (`python -m sharedcache.embedder`, port 8000, `EMBED_TOKEN`); the existing `projects/backfill/Dockerfile` (context = repo root, entrypoint `python -m sharedcache.backfill`).
- Produces: `deploy/gmi/docker-compose.yml` with services named exactly `embedder`, `backfill`, `cloudflared`; embedder reachable in-network at `http://embedder:8000`.

- [ ] **Step 1: Embedder Dockerfile**

Create `projects/embedder/Dockerfile`:

```dockerfile
FROM python:3.11-slim
WORKDIR /app

# CPU-only torch first (small wheel from the pytorch index), then the package.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY projects/embedder ./embedder
RUN pip install --no-cache-dir "./embedder[model]"

# Bake the ViT-L/14 weights into the image: immutable, fast start, no runtime egress.
RUN python -c "from sharedcache.embedder.model import OpenClipEncoder; OpenClipEncoder()"

EXPOSE 8000
CMD ["python", "-m", "sharedcache.embedder"]
```

- [ ] **Step 2: Keep the backfill image buildable**

Task 1 added `projects/embedder` to `[tool.uv.workspace] members`, but
`projects/backfill/Dockerfile` copies only common/generation/backfill into
its build context — `uv sync --frozen` inside that image now fails on the
missing member. In `projects/backfill/Dockerfile`, after
`COPY projects/backfill ./projects/backfill` add:

```dockerfile
COPY projects/embedder ./projects/embedder
```

(Packaging-only change; no backfill code is touched. The embedder package is
tiny — fastapi metadata only, the model extra is not installed here.)

Verify: `docker build -f projects/backfill/Dockerfile -t sharedcache-backfill:dev .` from the repo root — expected: builds.

- [ ] **Step 3: Compose stack**

Create `deploy/gmi/docker-compose.yml`:

```yaml
# One-box GMI deployment: CLIP embedder + backfill worker + Cloudflare Tunnel.
# Secrets/config come from deploy/gmi/.env (git-ignored); see README.md here.
services:
  embedder:
    build:
      context: ../..
      dockerfile: projects/embedder/Dockerfile
    environment:
      - EMBED_TOKEN=${EMBED_TOKEN}
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    restart: unless-stopped

  backfill:
    build:
      context: ../..
      dockerfile: projects/backfill/Dockerfile
    env_file:
      - .env
    environment:
      - CLIP_TEXT_EMBED_URL=http://embedder:8000/embed/text
      - CLIP_IMAGE_EMBED_URL=http://embedder:8000/embed/image
      - CLIP_EMBED_TOKEN=${EMBED_TOKEN}
    depends_on:
      embedder:
        condition: service_healthy
    restart: unless-stopped

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run --token ${TUNNEL_TOKEN}
    depends_on:
      - embedder
    restart: unless-stopped
```

- [ ] **Step 4: Runbook**

Create `deploy/gmi/README.md`:

```markdown
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
```

- [ ] **Step 5: Validate the stack shape**

Run: `grep -n '^\.env$' .gitignore` — expected: present (covers `deploy/gmi/.env`; do NOT add a duplicate).
Run: `cd deploy/gmi && EMBED_TOKEN=x TUNNEL_TOKEN=y docker compose config -q`
Expected: exit 0, no output (valid compose file).

- [ ] **Step 6: Build the embedder image (best effort, slow)**

Run: `cd /home/joris/Projects/suppers-ai/sharedcache && docker build -f projects/embedder/Dockerfile -t sharedcache-embedder:dev . ` (allow ~10 minutes; downloads CPU torch + weights).
Expected: image builds; then smoke it:

```bash
docker run -d --rm -p 18000:8000 -e EMBED_TOKEN=t --name embtest sharedcache-embedder:dev
sleep 25
curl -s http://localhost:18000/healthz
curl -s -X POST http://localhost:18000/embed/text -H "Authorization: Bearer t" -H "Content-Type: application/json" -d '{"inputs":"a fox"}' | head -c 60
docker stop embtest
```

Expected: `{"status":"ok"}` and a `[[...` vector with 768 floats. If the environment cannot build (no docker / no network), record that as a concern in your report instead of faking success — the compose `config -q` check still gates the task.

- [ ] **Step 7: Commit**

```bash
git add projects/embedder/Dockerfile projects/backfill/Dockerfile deploy/gmi
git commit -m "feat(deploy): GMI compose bundle — embedder, backfill, cloudflared tunnel"
```

---

### Task 3: Worker/env wiring + HANDOFF

**Files:**
- Modify: `projects/worker/wrangler.toml`, `.env.example`, `HANDOFF.md`

**Interfaces:**
- Consumes: public hostname `https://embed.wagmi.photos/embed/text` (Task 2); internal `http://embedder:8000/...` values.
- Produces: nothing downstream — this closes the loop.

- [ ] **Step 1: Point the Worker at the tunnel**

In `projects/worker/wrangler.toml`, replace

```toml
CLIP_TEXT_EMBED_URL = ""   # set to your CLIP ViT-L/14 text endpoint
```

with:

```toml
CLIP_TEXT_EMBED_URL = "https://embed.wagmi.photos/embed/text"  # GMI box via Cloudflare Tunnel (deploy/gmi)
```

- [ ] **Step 2: Update .env.example**

In the repo-root `.env.example`, replace the CLIP block

```
# --- CLIP embedding endpoints (swappable; HF Inference by default) ---
CLIP_TEXT_EMBED_URL=
CLIP_IMAGE_EMBED_URL=
CLIP_EMBED_TOKEN=
```

with:

```
# --- CLIP embedding endpoints (self-hosted sharedcache-embedder; see deploy/gmi) ---
# On the GMI box the backfill reaches the embedder over the compose network:
CLIP_TEXT_EMBED_URL=http://embedder:8000/embed/text
CLIP_IMAGE_EMBED_URL=http://embedder:8000/embed/image
CLIP_EMBED_TOKEN=
# Embedder bearer token (same value goes to `wrangler secret put CLIP_EMBED_TOKEN`)
EMBED_TOKEN=
# Cloudflare Tunnel token publishing embed.wagmi.photos (deploy/gmi/README.md)
TUNNEL_TOKEN=
```

- [ ] **Step 3: HANDOFF runbook section**

In `HANDOFF.md`, directly after the "## Domains & public URLs" section, add:

```markdown
## GMI box (embedder + backfill)

- One CPU GMI instance runs `deploy/gmi/docker-compose.yml`: the CLIP
  ViT-L/14 embedding service (`projects/embedder/`), the backfill worker,
  and a Cloudflare Tunnel publishing the embedder as `embed.wagmi.photos`.
- The Worker's `CLIP_TEXT_EMBED_URL` points at that hostname; its bearer
  token is the `CLIP_EMBED_TOKEN` secret (`wrangler secret put`). The
  backfill reaches the embedder in-network (`http://embedder:8000`).
- Full runbook: `deploy/gmi/README.md`. Local dev without a tunnel: run the
  embedder locally and point `projects/worker/.dev.vars`
  `CLIP_TEXT_EMBED_URL` at it.
```

- [ ] **Step 4: Verify suites and config**

Run: `cd projects/worker && npm test` — expected 69/69 (var change is config-only).
Run: `cd projects/worker && npx wrangler deploy --dry-run 2>&1 | tail -5` — expected bundle succeeds with the new var listed / no errors.
Run: `uv run pytest -q` from repo root — expected all pass.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/wrangler.toml .env.example HANDOFF.md
git commit -m "feat(worker): wire CLIP endpoint to embed.wagmi.photos + GMI runbook"
```
