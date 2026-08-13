# Hermes AgentBox + bulk rehost sweep

**Date:** 2026-07-21
**Status:** approved by Joris (design review in session)

## Goal

Fix the slow library grid at its root: rehost the ~510,498 un-rehosted library
assets (`locally_cached = 0`) to B2 so every image serves fast derived thumbs.
Delivery vehicle (Joris's explicit choice): a **GMI AgentBox agent** running
Nous Research's **hermes**, commanded over **Telegram** — the sweep is its
first mission; later missions (status checks, eventually generation) are new
chat messages, not new infra.

## Decisions made (with Joris)

1. **Approach C now** — AgentBox custom image, chosen deliberately over
   "plain GMI instance now, AgentBox later" after reviewing current docs.
   Joris prefers building the long-term shape immediately.
2. **Telegram, not Discord** — hermes's gateway supports both; Telegram's
   `TELEGRAM_ALLOWED_USERS` numeric allowlist is the tighter perimeter
   (the AgentBox guide's Discord flavor needs `GATEWAY_ALLOW_ALL_USERS=true`).
3. **Concurrency 8** in the rehost loop (~1–2 days wall-clock vs 6–12 serial).
4. **Paid generation stays off** — rehost-only entrypoints; enabling the
   generate pass is a future, explicit, spend-cap-reviewed decision.
5. **Private agent** — registered on AgentBox but never published to the
   marketplace.

## Phase 1 — sweep capability (repo code, independently valuable)

Lands first and works anywhere (even without the AgentBox): the box is the
delivery vehicle, not a dependency.

- `--rehost-only` flag in `projects/backfill/src/wagmiphotos/backfill/__main__.py`:
  loop mode calling ONLY `rehost_pass()` — structurally incapable of invoking
  the paid `generate_pass()`. Composes with `--once`.
- Bounded concurrency in `BackfillWorker.rehost_pass`
  (`projects/backfill/src/wagmiphotos/backfill/worker.py:184`):
  `asyncio.Semaphore(8)` + `asyncio.gather` within each batch, one shared
  httpx client. Per-record semantics unchanged: size cap
  (`DEFAULT_MAX_REHOST_BYTES`), `increment_rehost_attempts` +
  `MAX_REHOST_ATTEMPTS` skip, HTTP 404/410 → tombstone.
- Selection stays `assets_needing_rehost` (demand-ranked first, then trickle
  fill — already sweep-shaped; no query changes).
- TDD against the existing `projects/backfill/tests/` fakes harness:
  concurrency actually overlaps, one failure doesn't sink the batch,
  rehost-only mode never touches the generator fake.

## Phase 2 — the AgentBox image and registration

### Image: two layers

1. **Base (upstream-tracking):** fork `NousResearch/hermes-agent` into the
   wagmiphotos org; its official `deploy/agentbox/Dockerfile.agentbox` +
   GitHub Actions workflow publish `ghcr.io/wagmiphotos/hermes-agentbox`.
   Pin a release/commit — no floating `main` (hermes is 4 months old and
   fast-moving).
2. **Overlay (this repo, new `deploy/agentbox/`):** `FROM` the base, add:
   - the backfill package (reuse `projects/backfill/Dockerfile` install steps),
   - deterministic mission scripts: `sweep-start.sh` (detached
     `python -m wagmiphotos.backfill --rehost-only`, logs under `/data/logs`),
     `sweep-status.sh` (remaining `locally_cached=0` count, rate, last errors),
     `sweep-stop.sh`,
   - a baked operating manual (`AGENTS.md`) telling hermes exactly which
     scripts exist and that generation commands are prohibited,
   - entrypoint glue: map injected `GMI_MAAS_API_KEY`/`GMI_MAAS_BASE_URL` →
     hermes config (provider `gmi`, model from `HERMES_MODEL`), write the
     Telegram gateway config from env, symlink `~/.hermes` → `/data/hermes`,
     then start the hermes gateway (it serves AgentBox's required 8080).
   Published as `ghcr.io/wagmiphotos/wagmi-hermes-box`. Both images public,
   **zero secrets baked** — secrets exist only as AgentBox env vars.

### Interaction model

- Telegram (outbound long-poll — no inbound port beyond the gateway's 8080,
  which is keyed by `API_SERVER_KEY`). Allowlist: `TELEGRAM_ALLOWED_USERS` =
  Joris's numeric ID only.
- Hermes runs the named scripts — not improvised shell — per the baked manual.
- Sweep status: ask on Telegram ("status?") → agent runs `sweep-status.sh`.

### AgentBox env vars (wizard step 4)

`CF_ACCOUNT_ID`, `CF_API_TOKEN` (scoped: D1 + Vectorize edit only),
`D1_DATABASE_ID`, `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`,
`B2_PUBLIC_URL_BASE`, `TELEGRAM_BOT_TOKEN` (secret), `TELEGRAM_ALLOWED_USERS`,
`API_SERVER_KEY` (secret), `HERMES_MODEL` (e.g. `deepseek-ai/DeepSeek-V4-Pro`).
Similarity floors deliberately absent (contract.json-pinned defaults rule).

### Registration + validation runbook (deploy/agentbox/README.md)

Wizard: name, image URL, default tier (2 vCPU / 4 GB / 10 GiB ephemeral +
30 GiB data), region IOWA IDC-1, default port mapping 443→8080, env vars,
**register private**. Then validate in order:
1. container healthy; gateway answers on the public URL (keyed),
2. Telegram round-trip ("status?" → reply),
3. `/data` persistence check: write marker, restart instance, confirm marker
   (if it fails: accept hermes amnesia — sweep unaffected, D1 is the source
   of truth),
4. first mission: "start the rehost sweep".

### Sweep operation

- Progress metric: **not** `SELECT COUNT(*) FROM live_assets WHERE locally_cached = 0`.
  No index can answer that predicate (`idx_assets_rehostable` is partial on
  `locally_cached = 0 AND dead_at IS NULL` and would be walked end to end), so
  it reads ~510k rows per call — and `sweep-status.sh` is wired to a Telegram
  agent that runs it every time someone asks "status?", uncached and ad hoc.
  That is the exact pattern migration 0021 removed from `/v1/home` (see
  `scripts/recount-library.sql` and the 0021 header for the measurements).
  Instead: the sweep already knows how many assets it has rehosted, so have it
  maintain its own progress row (`meta`, key `rehost_progress`, written once
  per batch) and have `sweep-status.sh` read that single row. Take the true
  remaining count at most once at sweep start, not per status query.
  Completion = remaining count ≈ attempt-capped stragglers + 404/410
  tombstones; agent reports the straggler list for manual triage.
- Counter upkeep during the sweep: each 404/410 tombstone is an
  `UPDATE assets SET dead_at=...`, which fires the 0021 trigger and decrements
  `counters.library_assets` — correct and wanted (a tombstoned asset leaves the
  public count), and one extra row written per tombstone.
- Restart-safe: D1 flags/attempts are the only state; a container restart or
  redeploy just resumes.
- Homepage/library effects appear as thumbs immediately per-asset; the liked
  showcase self-heals as liked images get rehosted.

### Costs (accepted)

Container ~$0.0475/hr → ~$2 for the sweep, ~$34/mo if left always-on
(acceptable; stop via AgentBox endpoint when idle). B2 storage ~0.3 TB ≈
$2/mo. D1 writes ~1M ≈ ~$1. MaaS tokens negligible at chat cadence.

## Known unknowns + mitigations

- **`/data` persistence undocumented** → verified empirically in runbook
  step 3; sweep never depends on it.
- **Long-running detached jobs in the container** → scripts run `nohup`-style
  with logs on `/data`; if AgentBox recycles containers aggressively, the
  sweep resumes from D1 (worst case: slower, never wrong).
- **Hermes gateway config drift** (young project) → pinned version; overlay
  owns all glue so a version bump is a deliberate PR.

## Security posture

Public image, secrets only in env; CF token scoped to D1+Vectorize; Telegram
numeric allowlist = Joris; gateway HTTP keyed; paid generation structurally
absent from shipped entrypoints with worker lifetime spend caps as backstop;
private registration (no marketplace exposure).

## Out of scope / follow-ups

- Enabling the paid generate pass (future explicit mission after spend-cap
  review).
- Marketplace listing / verified badge.
- Porting the PD12M seeder to the box.
- Any worker/API changes (the SPA already prefers thumbs — no frontend work).
