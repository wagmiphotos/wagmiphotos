CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  prompt         TEXT NOT NULL,
  source         TEXT NOT NULL,
  source_id      TEXT,
  thumb_url      TEXT,
  medium_url     TEXT,
  url            TEXT NOT NULL,
  model_used     TEXT,
  content_hash   TEXT,
  width          INTEGER,
  height         INTEGER,
  mime           TEXT,
  source_url     TEXT,
  locally_cached INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS queries (
  normalized_prompt TEXT PRIMARY KEY,
  original_prompt   TEXT NOT NULL,
  count             INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending',
  last_asset_id     TEXT,
  last_similarity   REAL,
  first_seen        TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queries_pending_count ON queries (status, count DESC);
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
