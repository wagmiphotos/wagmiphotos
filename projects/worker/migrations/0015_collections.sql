-- Collections: owner-managed themed groupings of BYOK-generated images
-- (spec docs/superpowers/specs/2026-07-09-collections-design.md). The id is
-- unguessable ('col_' + 20 random base32 chars) and doubles as the share
-- capability: anyone who knows it may scope searches to the collection.
CREATE TABLE IF NOT EXISTS collections (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  theme_prompt  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);

-- collection_id: NULL for every pre-existing asset (plain library asset).
-- serve_count: how many times /v1/images/generations returned this asset as
-- hit/approximate. Owner-facing stat only — like created_by, neither column
-- joins ASSET_COLS, so public read paths never select them.
ALTER TABLE assets ADD COLUMN collection_id TEXT;
ALTER TABLE assets ADD COLUMN serve_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_assets_collection ON assets(collection_id) WHERE collection_id IS NOT NULL;
-- 0008's note: a migration that adds asset columns must recreate live_assets
-- so its SELECT * re-expands to expose them to every read path.
DROP VIEW IF EXISTS live_assets;
CREATE VIEW live_assets AS SELECT * FROM assets WHERE dead_at IS NULL;
