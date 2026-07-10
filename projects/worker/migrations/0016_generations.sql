-- Async BYOK generation jobs (spec 2026-07-10-read-write-split-async-collection-gen).
-- POST /v1/collections/:id/generations creates a row after the atomic quota
-- reserve; GET /v1/generations/:id drives it (poll-through) under the claim;
-- the cron sweep finishes abandoned rows. month records which byok_usage row
-- the reservation went into, so a terminal failure refunds the right month.
CREATE TABLE IF NOT EXISTS generations (
  id              TEXT PRIMARY KEY,                 -- 'gen_' + uuid
  user_id         TEXT NOT NULL REFERENCES users(id),
  collection_id   TEXT NOT NULL REFERENCES collections(id),
  prompt          TEXT NOT NULL,                    -- combined (user + theme) prompt
  provider        TEXT NOT NULL,                    -- 'openai' | 'gmicloud'
  provider_job_id TEXT,                             -- GMI request id / OpenAI response id; NULL while queued and for sync-mode jobs
  status          TEXT NOT NULL DEFAULT 'queued',   -- queued|generating|succeeded|failed
  asset_id        TEXT,
  error           TEXT,
  month           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_at      TEXT,                             -- drive claim (60s TTL); stale claims are reclaimable
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Sweep scans open jobs by staleness; owner GET checks are by primary key.
CREATE INDEX IF NOT EXISTS idx_generations_open ON generations(status, updated_at);
