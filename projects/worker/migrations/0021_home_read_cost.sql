-- Landing-page read cost (2026-08-13). Both /v1/home queries scanned the whole
-- assets table: COUNT(*) read 511,510 rows (~11s cold) and the 8-tile showcase
-- read 512,513 rows. ~1.02M rows per cache miss, and misses scale with colos,
-- not users — the daily D1 row count was 2-4 of these and nothing else.

-- 1. Showcase: leading equality columns for the two filters, then the exact
-- ORDER BY, so the LIMIT stops the walk after 8 entries instead of sorting
-- every candidate in a temp b-tree.
-- collection_id/locally_cached are index *columns* rather than partial-WHERE
-- terms deliberately: a partial index carrying no seekable column loses to
-- idx_assets_like_browse on cost and never gets picked. dead_at stays in the
-- partial WHERE so tombstones are absent from the index entirely and the walk
-- never stops on one.
CREATE INDEX IF NOT EXISTS idx_assets_showcase
  ON assets(collection_id, locally_cached, like_count DESC, created_at DESC, id ASC)
  WHERE dead_at IS NULL;

-- 2. Library count: a maintained counter instead of a full COUNT(*).
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Trigger-maintained (like like_count in 0020) rather than app-maintained: the
-- seed/backfill pipeline writes `assets` directly with raw multi-row INSERTs
-- and raw dead_at UPDATEs (common/d1_client.py), so only a trigger sees every
-- writer. "Counted" means a live public row: collection_id IS NULL AND
-- dead_at IS NULL — the same predicate /v1/home reports.
INSERT INTO counters (name, value)
  SELECT 'library_assets', COUNT(*) FROM assets WHERE collection_id IS NULL AND dead_at IS NULL
  ON CONFLICT(name) DO UPDATE SET value = excluded.value;

CREATE TRIGGER IF NOT EXISTS counters_assets_after_insert AFTER INSERT ON assets
WHEN NEW.collection_id IS NULL AND NEW.dead_at IS NULL
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'library_assets';
END;

CREATE TRIGGER IF NOT EXISTS counters_assets_after_delete AFTER DELETE ON assets
WHEN OLD.collection_id IS NULL AND OLD.dead_at IS NULL
BEGIN
  UPDATE counters SET value = value - 1 WHERE name = 'library_assets';
END;

-- Fires whenever an UPDATE's SET list mentions either column, even if the value
-- is unchanged, so the body computes a delta from OLD/NEW rather than assuming
-- a transition: re-tombstoning a dead row is a no-op, reviving one re-counts it.
CREATE TRIGGER IF NOT EXISTS counters_assets_after_update
AFTER UPDATE OF collection_id, dead_at ON assets
BEGIN
  UPDATE counters SET value = value
    + (CASE WHEN NEW.collection_id IS NULL AND NEW.dead_at IS NULL THEN 1 ELSE 0 END)
    - (CASE WHEN OLD.collection_id IS NULL AND OLD.dead_at IS NULL THEN 1 ELSE 0 END)
  WHERE name = 'library_assets';
END;
