# Monorepo Restructure — Design Spec

**Date:** 2026-07-02
**Status:** Approved for planning

## 1. Summary

Restructure the repo into a **monorepo** with independently-deployable, independently-versioned projects
under `projects/`, backed by a **uv workspace** (Python) plus the existing npm project (the TypeScript
Worker). This is a **pure reorganization** — no behavior changes, no new features. Both test suites must
stay green (Python 42, Worker 32).

Projects:
- `projects/worker/` — the Cloudflare Worker (TypeScript). Deploys to Cloudflare. Moved verbatim from `/worker`.
- `projects/common/` — Python library: shared data + config + Cloudflare/CLIP clients (the base every Python
  project depends on).
- `projects/generation/` — Python library: Genblaze (GMI Cloud) generation + Backblaze B2 storage + image
  processing.
- `projects/backfill/` — Python **application** (the "Hermes runner"): the demand-ranked backfill loop + seeder
  + Dockerfile. Deploys to a GMI Cloud Hermes agentbox. Depends on `common` + `generation`.

Dependency graph (Python): `common` ← `generation` ← `backfill`. The Worker is standalone (shares only the
D1/Vectorize *contract*, not code).

## 2. Goals / non-goals

**Goals**
- Each project is a real, independently-installable/versioned package with its own manifest.
- Clear boundaries: a reader can tell what each project does, how to use it, and what it depends on.
- One shared `uv.lock`; `uv run pytest` from the root runs all three Python suites; each package builds alone.
- Preserve git history (`git mv`) and keep both suites green — zero behavior change.

**Non-goals**
- No code/logic changes beyond import paths and packaging. No new features, no dependency upgrades.
- No CI pipeline authoring (out of scope; can follow later).
- The Worker's internals are untouched (only its directory moves).
- `web/index.html` is not turned into a project (stays at repo root; separate future work).

## 3. Target layout

```
sharedcache/
├── projects/
│   ├── worker/                              # TypeScript CF Worker (moved from /worker, otherwise unchanged)
│   │   └── src/ test/ migrations/ wrangler.toml package.json tsconfig.json vitest.config.ts
│   ├── common/
│   │   ├── src/sharedcache/common/          # models.py config.py floor.py clip.py d1_client.py vectorize_client.py __init__.py
│   │   ├── tests/                           # test_models test_config test_floor test_clip test_d1_client test_vectorize_client test_d1_migration
│   │   └── pyproject.toml
│   ├── generation/
│   │   ├── src/sharedcache/generation/      # generator.py storage.py processor.py __init__.py
│   │   ├── tests/                           # test_generator test_processor test_storage
│   │   └── pyproject.toml
│   └── backfill/
│       ├── src/sharedcache/backfill/        # worker.py seed_pd12m.py __init__.py __main__.py
│       ├── tests/                           # test_backfill test_seed_pd12m fakes.py
│       ├── Dockerfile
│       └── pyproject.toml
├── docs/                                    # shared (specs, plans) — unchanged
├── web/                                     # index.html playground — unchanged, stays at root
├── pyproject.toml                           # uv workspace root (members + shared dev deps + pytest config)
├── uv.lock                                  # single shared lock
├── .env.example  README.md  .gitignore
```

**Import namespace:** PEP 420 namespace packages under `sharedcache.*`. Each package owns
`src/sharedcache/<subpkg>/` and there is **no** `src/sharedcache/__init__.py` in any package (that absence is
what makes `sharedcache` a shared namespace). The subpackages (`sharedcache/common/__init__.py`, etc.) are
regular packages. Result: `from sharedcache.common.models import AssetRecord`.

## 4. File → project mapping (exact)

Current `src/sharedcache/` and `scripts/`, `tests/` move as follows (via `git mv`):

| Current | New |
|---|---|
| `src/sharedcache/models.py` | `projects/common/src/sharedcache/common/models.py` |
| `src/sharedcache/config.py` | `projects/common/src/sharedcache/common/config.py` |
| `src/sharedcache/floor.py` | `projects/common/src/sharedcache/common/floor.py` |
| `src/sharedcache/clip.py` | `projects/common/src/sharedcache/common/clip.py` |
| `src/sharedcache/d1_client.py` | `projects/common/src/sharedcache/common/d1_client.py` |
| `src/sharedcache/vectorize_client.py` | `projects/common/src/sharedcache/common/vectorize_client.py` |
| `src/sharedcache/generator.py` | `projects/generation/src/sharedcache/generation/generator.py` |
| `src/sharedcache/storage.py` | `projects/generation/src/sharedcache/generation/storage.py` |
| `src/sharedcache/processor.py` | `projects/generation/src/sharedcache/generation/processor.py` |
| `src/sharedcache/backfill.py` | `projects/backfill/src/sharedcache/backfill/worker.py` |
| `scripts/seed_pd12m.py` | `projects/backfill/src/sharedcache/backfill/seed_pd12m.py` |
| `src/sharedcache/__init__.py` | **deleted** (namespace packages have no top-level `sharedcache/__init__.py`) |
| `Dockerfile` | `projects/backfill/Dockerfile` |
| `/worker/**` | `projects/worker/**` |
| `tests/test_models.py`,`test_config.py`,`test_floor.py`,`test_clip.py`,`test_d1_client.py`,`test_vectorize_client.py`,`test_d1_migration.py` | `projects/common/tests/` |
| `tests/test_generator.py`,`test_processor.py`,`test_storage.py` | `projects/generation/tests/` |
| `tests/test_backfill.py`,`test_seed_pd12m.py`,`tests/fakes.py` | `projects/backfill/tests/` |
| `tests/__init__.py`,`tests/conftest.py` | dropped (each package's `tests/` gets its own if needed) |

New file: `projects/backfill/src/sharedcache/backfill/__main__.py` (holds `main()` so `python -m sharedcache.backfill`
works; `worker.py` keeps `BackfillWorker`, `build_worker_from_settings`, `run`).

## 5. Package manifests

**Root `pyproject.toml`** (virtual workspace root — not itself a distributable):
```toml
[tool.uv.workspace]
members = ["projects/common", "projects/generation", "projects/backfill"]

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["projects/common/tests", "projects/generation/tests", "projects/backfill/tests"]
```

**`projects/common/pyproject.toml`**
```toml
[project]
name = "sharedcache-common"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27", "pydantic-settings>=2.5"]
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
[tool.hatch.build.targets.wheel]
packages = ["src/sharedcache"]   # ships the sharedcache/common namespace subpackage
```

**`projects/generation/pyproject.toml`**
```toml
[project]
name = "sharedcache-generation"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["pillow>=10", "genblaze[openai]>=0.4,<0.5", "sharedcache-common"]
[tool.uv.sources]
sharedcache-common = { workspace = true }
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
[tool.hatch.build.targets.wheel]
packages = ["src/sharedcache"]
```

**`projects/backfill/pyproject.toml`**
```toml
[project]
name = "sharedcache-backfill"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27", "sharedcache-common", "sharedcache-generation"]
[project.scripts]
sharedcache-backfill = "sharedcache.backfill.__main__:main"
[tool.uv.sources]
sharedcache-common = { workspace = true }
sharedcache-generation = { workspace = true }
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
[tool.hatch.build.targets.wheel]
packages = ["src/sharedcache"]
```

## 6. Import rewrites

Rewrite every intra-repo import to the namespaced path (mechanical, whole-word):
- `sharedcache.models` → `sharedcache.common.models`
- `sharedcache.config` → `sharedcache.common.config`
- `sharedcache.floor` → `sharedcache.common.floor`
- `sharedcache.clip` → `sharedcache.common.clip`
- `sharedcache.d1_client` → `sharedcache.common.d1_client`
- `sharedcache.vectorize_client` → `sharedcache.common.vectorize_client`
- `sharedcache.generator` → `sharedcache.generation.generator`
- `sharedcache.storage` → `sharedcache.generation.storage`
- `sharedcache.processor` → `sharedcache.generation.processor`
- `sharedcache.backfill` (module) → `sharedcache.backfill.worker` (for `BackfillWorker` etc.)

Test-specific updates:
- `from tests.fakes import FakeD1, FakeVectorize` → `from fakes import FakeD1, FakeVectorize` (co-located in
  `projects/backfill/tests/`; pytest's default import mode puts the test dir on `sys.path`).
- `tests/test_seed_pd12m.py`: replace the `importlib.util.spec_from_file_location(...)` path-loading with a
  normal `from sharedcache.backfill import seed_pd12m` (it's a proper package module now).
- `projects/common/tests/test_d1_migration.py`: read the migration from the worker project —
  `pathlib.Path(__file__).resolve().parents[3] / "projects" / "worker" / "migrations" / "0001_init.sql"`.

## 7. Backfill Dockerfile (workspace-aware)

`projects/backfill/Dockerfile` builds from the **repo-root** context so uv can resolve the workspace deps:
```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
COPY projects/common ./projects/common
COPY projects/generation ./projects/generation
COPY projects/backfill ./projects/backfill
RUN uv sync --frozen --no-dev --package sharedcache-backfill
ENTRYPOINT ["uv", "run", "--package", "sharedcache-backfill", "python", "-m", "sharedcache.backfill"]
```
Build: `docker build -f projects/backfill/Dockerfile -t sharedcache-backfill .` (context = repo root).

## 8. Testing / verification

- `uv sync` at root installs all three members editable into one env.
- `uv run pytest -q` from the root discovers and runs all three suites (42 tests, unchanged).
- `cd projects/worker && npm test` → 32 tests, unchanged.
- Each package builds independently: `uv build --package sharedcache-common` (and generation/backfill).
- No test's assertions change — only import lines and file locations.

## 9. Migration sequence (low-risk, mechanical)

1. Scaffold the workspace: create `projects/{common,generation,backfill}/` dirs + the four `pyproject.toml` +
   root workspace pyproject; `git mv /worker → projects/worker`.
2. `git mv` the Python source into the three packages; delete `src/sharedcache/__init__.py`.
3. `git mv` the tests into each package's `tests/`; rename `backfill.py`→`worker.py`; add `__main__.py`.
4. Rewrite imports (section 6) across source + tests.
5. `uv sync`, re-lock, run `uv run pytest` → green; run the worker suite → green.
6. Move + update the Dockerfile; update README paths; delete the now-empty `src/`, `scripts/`, `tests/` roots.

Done in a few commits so each step is verifiable; final state has both suites green.

## 10. Open assumptions (correct if wrong)

- Folder name is `projects/` (per your choice), not `packages/`.
- Import namespace is `sharedcache.*` PEP 420 namespace packages (not distinct `sc_*` top-level names).
- `web/index.html` stays at the repo root (not a project).
- `docs/` and `.env.example` stay shared at the root.
- Hatchling packaging of namespace subpackages via `packages = ["src/sharedcache"]` with no top-level
  `__init__.py` behaves as expected under uv editable installs; if a hatch namespace quirk appears, fall back to
  `[tool.hatch.build.targets.wheel] only-include = ["src/sharedcache/<subpkg>"]` per package.
- **Namespace-package risk + escape hatch:** the trickiest part is three workspace members each contributing to
  the `sharedcache.*` PEP 420 namespace under editable installs — the namespace must merge across members. The
  plan verifies this early (Task 1–2: after the first `git mv` + `uv sync`, confirm `python -c "import
  sharedcache.common.models"` resolves). If the editable namespace merge proves unreliable, fall back to
  **distinct top-level package names** (`sc_common`, `sc_generation`, `sc_backfill`) — a mechanical change to the
  import prefix and the `src/` dir names, no logic impact. This decision is confirmed early, before the bulk of
  the moves.
