-- generate: whether a pending prompt should be picked up by the backfill GPU worker.
-- Forward-only to 1: any request asking for generation wins over earlier opt-outs.
ALTER TABLE queries ADD COLUMN generate INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_queries_pending_generate_count ON queries (status, generate, count DESC);
