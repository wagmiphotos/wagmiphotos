-- Audit trail for user-driven generation: created_by records the account id
-- that generated a byok asset (NULL for seeded/backfill/rehosted assets —
-- nobody "owns" those). Operator-facing only: no public read path selects it
-- (ASSET_COLS in d1.ts deliberately excludes it), so user ids never leak into
-- library or generation responses.
ALTER TABLE assets ADD COLUMN created_by TEXT;
-- 0008's note: a migration that adds asset columns must recreate live_assets
-- so its SELECT * re-expands to expose them to every read path.
DROP VIEW IF EXISTS live_assets;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
