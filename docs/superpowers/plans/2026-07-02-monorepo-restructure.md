# Monorepo Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repo into a `projects/` monorepo — a uv workspace of three Python packages (`common`, `generation`, `backfill`) plus the existing TypeScript Worker — with zero behavior change and both test suites green.

**Architecture:** Pure reorganization via `git mv` + import-path rewrites. Python becomes a uv workspace (virtual root + 3 member packages) using PEP 420 namespace packages under `sharedcache.*`. The Worker moves verbatim to `projects/worker/`. Dependency graph: `common ← generation ← backfill`.

**Tech Stack:** uv workspaces, hatchling, pytest (Python); npm + vitest (Worker, untouched internally).

**Spec:** `docs/superpowers/specs/2026-07-02-monorepo-restructure-design.md` (§3 layout, §4 file map, §5 manifests, §6 import rewrites, §7 Dockerfile).

## Global Constraints

- **No behavior change** — only file locations, import paths, and packaging. No logic edits, no dependency version changes, no new features.
- Preserve git history: move files with `git mv`, never delete+recreate.
- Import namespace: PEP 420 **namespace packages** under `sharedcache.*` (`sharedcache.common.*`, `sharedcache.generation.*`, `sharedcache.backfill.*`). **No** `src/sharedcache/__init__.py` in any package. Escape hatch (spec §10): if the namespace merge fails under editable installs, fall back to distinct top-level names (`sc_common`/`sc_generation`/`sc_backfill`) — decided in Task 2 Step 2 before any real code moves.
- End state green: `uv run pytest -q` from repo root → **42 passed**; `cd projects/worker && npm test` → **32 passed**.
- Dependency graph: `common` (httpx, pydantic-settings) ← `generation` (pillow, genblaze[openai]) ← `backfill` (httpx). Workspace deps via `{ workspace = true }`.
- Folder name is `projects/`; `web/`, `docs/`, `.env.example` stay at repo root.

## File Structure (target — see spec §3/§4 for the full map)

```
projects/worker/            # TS Worker (git mv from /worker)
projects/common/src/sharedcache/common/       models config floor clip d1_client vectorize_client
projects/common/tests/                        test_models test_config test_floor test_clip test_d1_client test_vectorize_client test_d1_migration
projects/generation/src/sharedcache/generation/  generator storage processor
projects/generation/tests/                    test_generator test_processor test_storage
projects/backfill/src/sharedcache/backfill/   worker(.py) __main__ seed_pd12m
projects/backfill/tests/                      test_backfill test_seed_pd12m fakes
projects/backfill/Dockerfile
pyproject.toml (workspace root)  uv.lock
```

---

## Task 1: Move the Cloudflare Worker to `projects/worker/`

**Files:**
- Move: `worker/` → `projects/worker/` (git mv)
- Modify: `README.md` (worker paths), `.gitignore` (`worker/node_modules/` → `projects/worker/node_modules/`)

**Interfaces:**
- Produces: the Worker at `projects/worker/`, tests green there. No Python impact (this task is independent of the Python restructure).

- [ ] **Step 1: Move the worker directory**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
mkdir -p projects
git mv worker projects/worker
```

- [ ] **Step 2: Verify the worker suite still passes (paths inside are relative, unaffected)**

Run: `cd projects/worker && npm install && npx vitest run`
Expected: **32 passed** (9 files). (`wrangler.toml` `main = "src/index.ts"` is relative to the worker dir — unchanged.)

- [ ] **Step 3: Update `.gitignore`** — change the worker ignore path:

```
# was: worker/node_modules/
projects/worker/node_modules/
```
(Keep the top-level `node_modules/` line too.)

- [ ] **Step 4: Update `README.md`** — replace `cd worker` with `cd projects/worker` everywhere in the "Cloudflare Worker" section (the `npm install` / `npm test` / `npm run deploy` commands and any `worker/migrations` references become `projects/worker/migrations`).

- [ ] **Step 5: Commit**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git add -A
git commit -m "refactor: move Cloudflare Worker to projects/worker/"
```

---

## Task 2: Python uv workspace — `common` / `generation` / `backfill`

This is the coordinated Python move. The suite is only green again at the end (a restructure can't be half-applied). Step 2 is the **namespace risk-gate** — resolve it before moving real code.

**Files:**
- Create: `pyproject.toml` (rewrite root → workspace), `projects/common/pyproject.toml`, `projects/generation/pyproject.toml`, `projects/backfill/pyproject.toml`, `projects/backfill/src/sharedcache/backfill/__main__.py`
- Move (git mv): all of `src/sharedcache/*.py` and `scripts/seed_pd12m.py` and `tests/*.py` per spec §4
- Delete: `src/sharedcache/__init__.py`
- Modify: every moved `.py` (import rewrites per spec §6)

**Interfaces:**
- Produces: `from sharedcache.common.{models,config,floor,clip,d1_client,vectorize_client} import …`; `from sharedcache.generation.{generator,storage,processor} import …`; `from sharedcache.backfill.worker import BackfillWorker, build_worker_from_settings, normalize_prompt`; `python -m sharedcache.backfill` via `sharedcache/backfill/__main__.py:main`.

- [ ] **Step 1: Create the workspace + member manifests and empty namespace stubs**

Create the directory tree and `__init__.py` for each subpackage (the subpackages ARE regular packages; only the `sharedcache/` level is namespace — no `sharedcache/__init__.py`):

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
mkdir -p projects/common/src/sharedcache/common projects/common/tests
mkdir -p projects/generation/src/sharedcache/generation projects/generation/tests
mkdir -p projects/backfill/src/sharedcache/backfill projects/backfill/tests
touch projects/common/src/sharedcache/common/__init__.py
touch projects/generation/src/sharedcache/generation/__init__.py
touch projects/backfill/src/sharedcache/backfill/__init__.py
```

Rewrite the root `pyproject.toml` to a **virtual workspace root** (replace the whole file):

```toml
[tool.uv.workspace]
members = ["projects/common", "projects/generation", "projects/backfill"]

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["projects/common/tests", "projects/generation/tests", "projects/backfill/tests"]
```

`projects/common/pyproject.toml`:
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
packages = ["src/sharedcache"]
```

`projects/generation/pyproject.toml`:
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

`projects/backfill/pyproject.toml`:
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

- [ ] **Step 2: NAMESPACE RISK-GATE — verify the merge before moving real code**

Add a throwaway symbol to each stub so imports resolve, then sync + import all three:
```bash
echo "OK = True" > projects/common/src/sharedcache/common/__init__.py
echo "OK = True" > projects/generation/src/sharedcache/generation/__init__.py
echo "OK = True" > projects/backfill/src/sharedcache/backfill/__init__.py
uv sync
uv run python -c "import sharedcache.common, sharedcache.generation, sharedcache.backfill; print('namespace OK')"
```
Expected: prints `namespace OK`.

**If it fails** (namespace does not merge across editable members): STOP and switch to the escape hatch — rename the three subpackage dirs/imports to distinct top-level names `sc_common`, `sc_generation`, `sc_backfill` (i.e. `projects/common/src/sc_common/…`, `packages = ["src/sc_common"]`, imports `from sc_common.models …`). Report this switch; the rest of the plan's import rewrites then target `sc_common.*`/`sc_generation.*`/`sc_backfill.*` instead of `sharedcache.<subpkg>.*`. Then re-run this gate. Once green, restore the stubs to empty (`: > …/__init__.py`) and continue.

- [ ] **Step 3: Move the source files** (git mv, per spec §4):

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
# common
git mv src/sharedcache/models.py            projects/common/src/sharedcache/common/models.py
git mv src/sharedcache/config.py            projects/common/src/sharedcache/common/config.py
git mv src/sharedcache/floor.py             projects/common/src/sharedcache/common/floor.py
git mv src/sharedcache/clip.py              projects/common/src/sharedcache/common/clip.py
git mv src/sharedcache/d1_client.py         projects/common/src/sharedcache/common/d1_client.py
git mv src/sharedcache/vectorize_client.py  projects/common/src/sharedcache/common/vectorize_client.py
# generation
git mv src/sharedcache/generator.py         projects/generation/src/sharedcache/generation/generator.py
git mv src/sharedcache/storage.py           projects/generation/src/sharedcache/generation/storage.py
git mv src/sharedcache/processor.py         projects/generation/src/sharedcache/generation/processor.py
# backfill (backfill.py -> worker.py)
git mv src/sharedcache/backfill.py          projects/backfill/src/sharedcache/backfill/worker.py
git mv scripts/seed_pd12m.py                projects/backfill/src/sharedcache/backfill/seed_pd12m.py
# drop the old namespace root marker
git rm src/sharedcache/__init__.py
```
(The `__init__.py` stubs created in Step 1 stay — they are the subpackage markers, now empty.)

- [ ] **Step 4: Create `projects/backfill/src/sharedcache/backfill/__main__.py`** (holds `main()`; `worker.py` keeps `BackfillWorker`/`build_worker_from_settings`/`normalize_prompt` — delete the `main()` and `if __name__` block from `worker.py`):

```python
import argparse
import asyncio
from sharedcache.common.config import Settings
from sharedcache.backfill.worker import build_worker_from_settings


def main() -> None:
    parser = argparse.ArgumentParser(description="SharedCache backfill worker")
    parser.add_argument("--once", action="store_true", help="run a single tick and exit")
    args = parser.parse_args()
    s = Settings()
    worker = build_worker_from_settings(s)
    asyncio.run(worker.run(s.worker_interval_seconds, once=args.once))


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Move the tests** (git mv, per spec §4):

```bash
git mv tests/test_models.py tests/test_config.py tests/test_floor.py tests/test_clip.py \
       tests/test_d1_client.py tests/test_vectorize_client.py tests/test_d1_migration.py \
       projects/common/tests/
git mv tests/test_generator.py tests/test_processor.py tests/test_storage.py \
       projects/generation/tests/
git mv tests/test_backfill.py tests/test_seed_pd12m.py tests/fakes.py \
       projects/backfill/tests/
git rm tests/__init__.py tests/conftest.py 2>/dev/null || true
```

- [ ] **Step 6: Rewrite imports across all moved source + tests** (spec §6). Apply this whole-word mapping to every `.py` under `projects/*/src` and `projects/*/tests`:

| From | To |
|---|---|
| `sharedcache.models` | `sharedcache.common.models` |
| `sharedcache.config` | `sharedcache.common.config` |
| `sharedcache.floor` | `sharedcache.common.floor` |
| `sharedcache.clip` | `sharedcache.common.clip` |
| `sharedcache.d1_client` | `sharedcache.common.d1_client` |
| `sharedcache.vectorize_client` | `sharedcache.common.vectorize_client` |
| `sharedcache.generator` | `sharedcache.generation.generator` |
| `sharedcache.storage` | `sharedcache.generation.storage` |
| `sharedcache.processor` | `sharedcache.generation.processor` |
| `sharedcache.backfill import` | `sharedcache.backfill.worker import` |

Command (from repo root):
```bash
grep -rl "sharedcache\." projects/common/src projects/generation/src projects/backfill/src \
        projects/common/tests projects/generation/tests projects/backfill/tests | while read f; do
  sed -i \
    -e 's/sharedcache\.models/sharedcache.common.models/g' \
    -e 's/sharedcache\.config/sharedcache.common.config/g' \
    -e 's/sharedcache\.floor/sharedcache.common.floor/g' \
    -e 's/sharedcache\.clip/sharedcache.common.clip/g' \
    -e 's/sharedcache\.d1_client/sharedcache.common.d1_client/g' \
    -e 's/sharedcache\.vectorize_client/sharedcache.common.vectorize_client/g' \
    -e 's/sharedcache\.generator/sharedcache.generation.generator/g' \
    -e 's/sharedcache\.storage/sharedcache.generation.storage/g' \
    -e 's/sharedcache\.processor/sharedcache.generation.processor/g' \
    -e 's/sharedcache\.backfill import/sharedcache.backfill.worker import/g' \
    "$f"
done
```
Then verify no double-rewrite happened (e.g. `sharedcache.common.common`): `grep -rn "common\.common\|generation\.generation" projects || echo clean`.

- [ ] **Step 7: Fix the three test files with special cases:**

`projects/backfill/tests/test_backfill.py` and `projects/backfill/tests/test_seed_pd12m.py` — the fakes import:
```
# from tests.fakes import FakeD1, FakeVectorize   →
from fakes import FakeD1, FakeVectorize
```
`projects/backfill/tests/fakes.py` — its own import: `from sharedcache.common.d1_client import QueryRow` (the sed in Step 6 already handled `sharedcache.d1_client`; confirm it reads `sharedcache.common.d1_client`).

`projects/backfill/tests/test_seed_pd12m.py` — replace the `importlib.util.spec_from_file_location(...)` block that loads the script by path with a normal import (it's a package module now):
```python
from sharedcache.backfill import seed_pd12m
```
(Delete the `importlib`/`pathlib` spec-loading lines; keep the rest of the test using `seed_pd12m.seed_rows`.)

`projects/common/tests/test_d1_migration.py` — the migration path moved under the worker project:
```python
SQL = (pathlib.Path(__file__).resolve().parents[3] / "projects" / "worker" / "migrations" / "0001_init.sql").read_text()
```
(`parents[3]` = repo root from `projects/common/tests/test_d1_migration.py`.)

- [ ] **Step 8: Sync + run the full suite**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
uv sync
uv run pytest -q
```
Expected: **42 passed** (no skips). If an import error appears, grep the offending module for a missed rewrite from the Step 6 table and fix it.

- [ ] **Step 9: Confirm the entrypoint + a build resolve**

```bash
uv run python -c "import sharedcache.backfill.__main__ as m; print(callable(m.main))"   # True
uv run python -m sharedcache.backfill --help                                            # prints argparse usage
uv build --package sharedcache-common >/dev/null && echo "common builds"
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: split Python into uv workspace (common/generation/backfill)"
```

---

## Task 3: Backfill Dockerfile + README + root cleanup

**Files:**
- Move: `Dockerfile` → `projects/backfill/Dockerfile` (git mv), then rewrite for the workspace build
- Modify: `README.md` (backfill run/paths), remove now-empty `src/`, `scripts/`, `tests/` roots

**Interfaces:**
- Consumes: the workspace from Task 2.
- Produces: a workspace-aware backfill image + accurate docs; a clean repo root.

- [ ] **Step 1: Move + rewrite the Dockerfile**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git mv Dockerfile projects/backfill/Dockerfile
```
Replace `projects/backfill/Dockerfile` contents with the workspace-aware build (context = repo root):
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

- [ ] **Step 2: Remove the now-empty legacy roots** (they should have no tracked files left after Task 2):

```bash
rmdir src/sharedcache src scripts tests 2>/dev/null || true
# if any are non-empty, list what's left and stop:
ls -la src scripts tests 2>/dev/null || echo "legacy roots gone"
```

- [ ] **Step 3: Update `README.md`** — the "Backfill worker" section: `python -m sharedcache.backfill --once` still works (unchanged); update the seed command path to `uv run python -m sharedcache.backfill.seed_pd12m` **or** `projects/backfill/src/sharedcache/backfill/seed_pd12m.py`; update the Docker build line to `docker build -f projects/backfill/Dockerfile -t sharedcache-backfill .` (context = repo root). Update the "Running tests" block to `uv run pytest` (from root) and `cd projects/worker && npm test`. Add a one-line "Repo layout" note pointing at `projects/{worker,common,generation,backfill}`.

- [ ] **Step 4: If Docker is available, verify the image builds** (context = repo root):

Run: `docker build -f projects/backfill/Dockerfile -t sharedcache-backfill . 2>&1 | tail -15`
Expected: builds. If Docker is absent, note it and skip (Dockerfile validated by inspection).

- [ ] **Step 5: Final green check — both suites**

```bash
uv run pytest -q                       # 42 passed
cd projects/worker && npx vitest run   # 32 passed
```

- [ ] **Step 6: Commit**

```bash
cd /home/joris/Projects/suppers-ai/sharedcache
git add -A
git commit -m "chore: workspace-aware backfill Dockerfile, README, root cleanup"
```

---

## Self-Review Notes (author checklist — done)

- **Spec coverage:** §3 layout → Tasks 1–3; §4 file map → Task 2 Steps 3/5 + Task 1 (worker); §5 manifests → Task 2 Step 1; §6 import rewrites → Task 2 Step 6/7; §7 Dockerfile → Task 3 Step 1; §8 verification → Task 2 Step 8 + Task 3 Step 5; §9 sequence → the three tasks; §10 namespace escape hatch → Task 2 Step 2.
- **Placeholder scan:** none — every step has concrete commands/code. The only conditional is the namespace fallback (Task 2 Step 2), which is fully specified.
- **Type/behavior consistency:** no logic changes; `backfill.py`→`worker.py` keeps `BackfillWorker`/`build_worker_from_settings`/`normalize_prompt`, `main()` relocated to `__main__.py`; every import mapping in Step 6 matches the file moves in Step 3; test special-cases (fakes import, seed importlib→import, migration path) all covered in Step 7.
- **Ordering:** worker move (independent) → Python workspace (namespace-gated, single green checkpoint) → Docker/docs/cleanup. Each task ends green.
