-- Image likes (Task: public library + likes, 2026-07-20).
-- like_count on assets is maintained by triggers so it can never drift from the
-- likes table: the app only ever writes `likes` (INSERT OR IGNORE / DELETE).
CREATE TABLE IF NOT EXISTS likes (
  user_id    TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_asset ON likes(asset_id);

ALTER TABLE assets ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

-- Recreate the view so its SELECT * reflects the new column (house convention; see 0009/0014/0015).
DROP VIEW IF EXISTS live_assets;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;

CREATE TRIGGER IF NOT EXISTS likes_after_insert AFTER INSERT ON likes
BEGIN
  UPDATE assets SET like_count = like_count + 1 WHERE id = NEW.asset_id;
END;
CREATE TRIGGER IF NOT EXISTS likes_after_delete AFTER DELETE ON likes
BEGIN
  UPDATE assets SET like_count = like_count - 1 WHERE id = OLD.asset_id;
END;

-- Serves the default browse: WHERE collection_id IS NULL ORDER BY like_count DESC, locally_cached DESC, id.
CREATE INDEX IF NOT EXISTS idx_assets_like_browse
  ON assets(collection_id, like_count DESC, locally_cached DESC, id);
