# wagmi.photos — TODO

Semantic image-generation cache for the **Backblaze Generative Media Hackathon**
(deadline **Aug 3, 2026, 5:00 pm EDT**; judging Aug 5–11). Requires Backblaze
**B2** + **Genblaze**.

Where things live:

- **Current state / resume here:** `HANDOFF.md` (root) → `docs/HANDOFF-2026-07-07.md`
- **Deployment runbook:** `DEPLOY.md` (ordered; includes migrations, secrets, GMI box)
- **Design trail:** `docs/superpowers/` (specs + plans)
- Archived FastAPI/pgvector-era docs: `docs/archive/` (historical only)

## 1. Deploy / live verification (the big open item)

Everything is verified offline with fakes; nothing has run against live infra.
Follow `DEPLOY.md` in order — it covers D1 create + migrations (through `0007`),
the three Vectorize shards, the BGE embedding drift check, seeding, and floor tuning.

- [x] **Task 6 — BGE live provisioning:** done in the launch session — shards
      `wagmiphotos-bge-0/1/2` live (333/343/324 vectors), drift check passed at
      cosine 1.0000 (after force-flipping Workers AI's mean pooling), 1k pool
      seeded, floors tuned live to 0.87/0.75. See `HANDOFF.md`.
- [x] **wagmiphotos rename:** worker (`wagmiphotos-worker`), D1 (`wagmiphotos`),
      Vectorize shards (`wagmiphotos-bge-0/1/2`), Python packages
      (`wagmiphotos-common`/`-generation`/`-backfill`), and docs (README/DEPLOY/
      HANDOFF/.env.example/skills) all reconciled to the wagmi.photos brand —
      the GitHub origin was already renamed.

## 2. Hackathon submission

- [x] Create the project's own public GitHub repo — done: origin =
      `github.com/wagmiphotos/wagmiphotos`, `main` pushed.
- [ ] Deploy to a public URL judges can test (`DEPLOY.md`); note a test
      login / API key in the submission.
- [ ] Record **<3-min demo video** (YouTube/Vimeo) — show a miss getting
      queued, the backfill building it, the follow-up HIT, and the **"$ saved"**
      counter.
- [ ] Devpost write-up: what it does, **how it uses B2**, **how it uses
      Genblaze**, and the **providers/models** used (README covers these).
- [ ] (Bonus) File substantive product feedback as Genblaze repo issues →
      **Feedback Prize**.
- [ ] Submit on Devpost before **Aug 3, 2026, 5:00 pm EDT**.

## 3. Optional follow-ups (non-blocking)

- [ ] **Scheduled token/session GC:** expired sessions and login tokens are now
      purged opportunistically during login requests; a scheduled sweep (cron
      trigger) is optional extra hardening for long idle periods.
- [ ] Remaining hardening/nice-to-haves are tracked in `DEPLOY.md` → "Still
      open" and `HANDOFF.md` → "Next steps".
