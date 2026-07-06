-- Backfill reliability + accounts GC support.

-- queries: attempt tracking so a permanently failing prompt falls out of the
-- demand-ranked queue instead of stalling it (the backfill skips rows with
-- attempts >= its retry budget), plus a claim timestamp so concurrent backfill
-- workers don't double-generate the same prompt. status gains a transient
-- 'building' value while a worker holds the claim; stale claims (claimed_at
-- older than the claim TTL) are reclaimable.
ALTER TABLE queries ADD COLUMN attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queries ADD COLUMN last_error TEXT;
ALTER TABLE queries ADD COLUMN claimed_at TEXT;

-- assets: same starvation fix for the rehost queue — permanently failing
-- sources stop blocking the head of the WHERE locally_cached=0 scan.
ALTER TABLE assets ADD COLUMN rehost_attempts INTEGER NOT NULL DEFAULT 0;

-- assets: persist the provenance manifest location (was silently dropped on
-- insert; previously only findable by path convention).
ALTER TABLE assets ADD COLUMN manifest_url TEXT;

-- meta: single-row-per-key state. Used for the durable lifetime spend counter
-- (key 'backfill_lifetime_spend_usd') so the cost cap survives restarts.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Session GC scans by expiry; login_tokens already has this index (0004).
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Superseded by idx_queries_pending_generate_count (0002); drop the redundant
-- write amplification on the hottest write table.
DROP INDEX IF EXISTS idx_queries_pending_count;
