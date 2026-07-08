-- Append-only audit trail of AUP acceptances. The users.tos_version/_at columns
-- (0010) hold the *current* status for the fast /v1/me gate check; this table
-- preserves *every* acceptance event with the evidence you'd want if a claim is
-- ever disputed: who, which version, when, from what IP + user-agent. Never
-- updated or deleted.
CREATE TABLE IF NOT EXISTS tos_acceptances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  tos_version TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tos_acceptances_user ON tos_acceptances (user_id, accepted_at);
