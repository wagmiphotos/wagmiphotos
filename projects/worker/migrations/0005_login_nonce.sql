-- Bind each login token to the browser that requested it: nonce_hash is
-- sha256 of a random nonce set as an HttpOnly cookie at /v1/auth/login and
-- required (atomically) to redeem the token. Defeats login session-fixation
-- and email-scanner prefetch. Nullable so the ALTER is safe; new rows always set it.
ALTER TABLE login_tokens ADD COLUMN nonce_hash TEXT;
