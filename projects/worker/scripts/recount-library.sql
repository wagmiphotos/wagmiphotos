-- Repair counters.library_assets (migration 0021) from the source of truth.
--
-- The counter is trigger-maintained and every real writer keeps it exact, so
-- this should never be needed. Run it if the count is suspect — the known way
-- to drift it is `INSERT OR REPLACE INTO assets`, which fires the INSERT
-- trigger but not the DELETE trigger (SQLite only fires the latter for REPLACE
-- when PRAGMA recursive_triggers is on, and it is off by default). No writer
-- does that today; d1-real-schema.test.ts pins both the drift and this repair.
--
--   npx wrangler d1 execute wagmiphotos --remote --file=scripts/recount-library.sql
--
-- Costs one full scan of assets (~511k rows) — that is the read this migration
-- exists to remove from the request path, so keep it an operator action and
-- never wire it into a handler or the cron.
UPDATE counters
   SET value = (SELECT COUNT(*) FROM assets WHERE collection_id IS NULL AND dead_at IS NULL)
 WHERE name = 'library_assets';
