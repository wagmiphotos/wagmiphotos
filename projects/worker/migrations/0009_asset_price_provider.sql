-- Per-image cost + provenance. price_usd captures the price charged at
-- generation time, stored per-image so the figure survives changes to the
-- image_price_usd constant or a model switch; provider records which backend
-- generated the asset (model_used holds only the bare model slug). Both are
-- NULL for seeded/rehosted PD12M assets (no generation cost, no provider).
ALTER TABLE assets ADD COLUMN price_usd REAL;
ALTER TABLE assets ADD COLUMN provider  TEXT;
-- 0008's note: a migration that adds asset columns must recreate live_assets
-- so its SELECT * re-expands to expose them to every read path.
DROP VIEW IF EXISTS live_assets;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
