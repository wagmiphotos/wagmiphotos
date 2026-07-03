-- Backs the library browse/search ordering (searchAssets: ORDER BY created_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS idx_assets_created_id ON assets (created_at DESC, id DESC);
