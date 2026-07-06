CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_expires ON login_tokens (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

ALTER TABLE api_keys ADD COLUMN user_id TEXT;
ALTER TABLE api_keys ADD COLUMN label   TEXT;
-- Intentional, IRREVERSIBLE: anonymous key minting is removed — keys are now
-- issued only to a logged-in user. This wipes ALL pre-existing (ownerless)
-- api_keys. Breaking change for any live SDK key; see DEPLOY.md before applying.
DELETE FROM api_keys WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
