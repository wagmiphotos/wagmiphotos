-- Owner-scoped reads on generations added 2026-07-13:
--   countOpenByUser        (WHERE user_id = ? AND status IN (...))  — the concurrency gate
--   listPendingByCollection(WHERE collection_id = ? AND user_id = ? AND status IN (...))
-- 0016 only indexed (status, updated_at) for the global cron sweep.
CREATE INDEX IF NOT EXISTS idx_generations_user_status ON generations(user_id, status);
