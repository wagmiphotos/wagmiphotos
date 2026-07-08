-- BYOK: per-user provider key (encrypted at rest — AES-256-GCM under the
-- BYOK_KEK worker secret; key_ciphertext = base64(iv || ciphertext)) plus
-- per-calendar-month (UTC, 'YYYY-MM') usage counters. One key per user;
-- switching provider replaces the row. Usage rows survive key deletion so
-- history and the spend estimate are not erasable by re-adding a key.
CREATE TABLE IF NOT EXISTS byok_keys (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  provider       TEXT NOT NULL CHECK (provider IN ('openai','gmicloud')),
  key_ciphertext TEXT NOT NULL,
  key_last4      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  monthly_cap    INTEGER NOT NULL DEFAULT 50,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS byok_usage (
  user_id       TEXT NOT NULL,
  month         TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  est_spend_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
