-- Terms/Acceptable-Use acceptance tracking. Mirrors how upstream providers push
-- infringement liability to the operator: users accept an AUP (which prohibits
-- infringing/illegal prompts and indemnifies us) and we record which version
-- they accepted and when. NULL = never accepted; a version older than the
-- current TOS_VERSION means re-acceptance is required.
ALTER TABLE users ADD COLUMN tos_version     TEXT;
ALTER TABLE users ADD COLUMN tos_accepted_at TEXT;
