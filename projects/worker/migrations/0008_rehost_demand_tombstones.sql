-- Demand-ranked rehosting + tombstones (spec 2026-07-07-demand-rehost-tombstones).
-- dead_at doubles as the liveness flag and the audit timestamp; dead_reason is a
-- short cause: 'http 404', 'http 410', 'retries exhausted'.
-- live_assets owns the dead_at IS NULL invariant: every read path that wants
-- living assets selects FROM live_assets; writes keep targeting assets.
-- NOTE: any later migration that adds asset columns should DROP VIEW live_assets
-- and recreate it — defensive: * re-expansion timing on schema changes is an
-- engine detail we don't want to depend on.
ALTER TABLE assets ADD COLUMN dead_at TEXT;
ALTER TABLE assets ADD COLUMN dead_reason TEXT;
-- (indexed on id, not rowid: SQLite's CREATE INDEX cannot reference rowid)
CREATE INDEX IF NOT EXISTS idx_assets_rehostable ON assets(id)
  WHERE locally_cached = 0 AND dead_at IS NULL;
CREATE VIEW IF NOT EXISTS live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
