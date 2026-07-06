# User accounts + magic-link login — design

**Date:** 2026-07-06
**Status:** Approved

## Purpose

Introduce real user identity to wagmi.photos. Today there are **no accounts**: the
account page is a browser/`localStorage` dashboard, and API "auth" is an anonymous
Bearer key (`api_keys` stores only a hash, no owner) that anyone can self-mint via
`POST /v1/keys/generate` — or, with `MASTER_API_KEY` unset, the API is fully open.

This build gates the product behind a passwordless **email magic-link** login, ties
API keys and usage to a real user, and removes anonymous key minting.

## Scope

- **Gated (login required):** the `#/playground`, `#/library`, and `#/account` SPA
  views, and the API endpoints `POST /v1/images/generations`, `GET /v1/library`,
  `GET /v1/library/:id/download`, and `POST /v1/keys/generate`.
- **Public (unchanged):** the informational routes — landing (`#/`), `#/pricing`,
  `#/docs`, `#/openai`, `#/clip`, `#/agents`, `#/legal` — and `GET /healthz`,
  `GET /v1/meta/stars`.
- **Auth method:** email magic link only. No passwords, no social OAuth in this build.
- **Email delivery:** Resend HTTP API.
- **Sessions:** server-side records in D1 + an HttpOnly cookie (revocable).
- **Legacy keys:** none exist in production. Require `user_id` going forward; any
  ownerless `api_keys` rows are treated as invalid (and wiped by the migration). No
  grace-period logic.

Out of scope (explicit follow-ups): billing/payment, plan entitlements enforcement,
social OAuth, "sign out everywhere" UI, org/team accounts, server-side persistence of
the telemetry counters (they stay client-side for now).

## Data model — D1 migration `0004`

(The existing migrations are `0001`–`0003`; this is the next one.)

```sql
CREATE TABLE users (
  id         TEXT PRIMARY KEY,          -- random id (e.g. usr_<base64url>)
  email      TEXT NOT NULL UNIQUE,      -- normalized: trimmed + lowercased
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,          -- sha256(raw token); raw token never stored
  email      TEXT NOT NULL,             -- normalized target email
  expires_at TEXT NOT NULL,             -- ~15 min from issue
  used_at    TEXT                       -- set when redeemed; single-use
);
CREATE INDEX idx_login_tokens_expires ON login_tokens (expires_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256(raw session token)
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL              -- ~30 days; sliding renewal
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- api_keys gains an owner. Existing ownerless rows are invalid.
ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE api_keys ADD COLUMN label   TEXT;
DELETE FROM api_keys WHERE user_id IS NULL;   -- no legacy keys exist
CREATE INDEX idx_api_keys_user ON api_keys (user_id);
```

Raw tokens (login + session) are **never** stored — only their SHA-256 hashes, so a
D1 read leak can't be used to log in. Reuse `sha256Hex` from `src/auth.ts`.

## Backend

### Two auth lanes

`checkAuth` (currently Bearer-only) is generalized to resolve a **user** from a request
by either lane, returning the `user_id` (or `null`):

1. **Session cookie** (humans / the SPA): read the `wagmi_session` cookie → `sha256` →
   look up `sessions` → if unexpired, return its `user_id` (and slide `expires_at`).
2. **Bearer API key** (programmatic / SDK): `sha256(token)` → look up `api_keys` → return
   its `user_id`. A key with `user_id IS NULL` is invalid. `MASTER_API_KEY` still matches
   (constant-time) as an **admin** principal (a sentinel user id, e.g. `usr_master`).

The gated endpoints accept **either** lane. The playground (browser) authenticates by
cookie; SDK callers by key. `MASTER_API_KEY`-unset dev-open mode is preserved **only**
for the API lane in local dev (documented as dev-only).

### Auth endpoints

`POST /v1/auth/login` — body `{ "email": "…" }`.
- Normalize email (trim + lowercase); validate shape; reject obviously invalid → `400`.
- Rate-limit per email **and** per IP (reuse the `RATE_LIMITER` binding, namespaced
  `login:<ip>` and `login:<email>`; ~5 / hour). On limit → still return the generic 200.
- Mint a 32-byte random token; insert `sha256(token)` + email + 15-min expiry into
  `login_tokens`. Send the email via the email module (below) with link
  `${PUBLIC_SITE_URL}/v1/auth/verify?token=<raw>`.
- **Always** respond `200 { "status": "sent" }` regardless of whether the email is
  known or rate-limited — no account-enumeration signal.

`GET /v1/auth/verify?token=…`
- `sha256(token)` → look up `login_tokens`. Reject if missing, `used_at` set, or expired
  → redirect to `#/login?error=expired` (no detail leaked).
- Mark `used_at = now` (single-use). Upsert `users` by email (`INSERT … ON CONFLICT(email)
  DO UPDATE SET last_login = now`).
- Create a session: 32-byte token, store `sha256` + `user_id` + 30-day expiry.
- Set cookie `wagmi_session=<raw>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…`
  (omit `Secure` when the request is plain-HTTP localhost so dev works).
- `302` redirect to `${PUBLIC_SITE_URL}/#/playground`.

`GET /v1/me`
- Resolve user via cookie only. `200 { "user": { "id", "email" } }` or `401`.
- The SPA calls this on load to choose logged-in vs. login screen.

`POST /v1/auth/logout`
- Delete the session row for the presented cookie; clear the cookie (`Max-Age=0`).
  `200 { "status": "ok" }`.

### Changes to existing endpoints

- `POST /v1/keys/generate` → now requires an authenticated **session** (not a key).
  Inserts the new key with `user_id` (and optional `label` from the body). Still
  IP-rate-limited. Returns the raw key once.
- `POST /v1/images/generations`, `GET /v1/library`, `GET /v1/library/:id/download` →
  require a resolved user (either lane). Unauthenticated → `401 { "error": "…" }`.
  - Note: this makes the library non-public, reversing the previous "public library"
    decision — intended, per "gate the whole product."
- Per-user rate limiting: namespace the existing generation rate-limit by `user_id`
  instead of IP where a user is resolved (`gen:<user_id>`), falling back to IP for the
  admin/master lane.

### New modules

- `src/session.ts` — cookie parse/serialize, session create/resolve/revoke, the
  unified `resolvePrincipal(request, env, stores)` used by the route handlers.
- `src/email.ts` — `sendMagicLink(email, link, env)` via Resend
  (`POST https://api.resend.com/emails`, `Authorization: Bearer RESEND_API_KEY`,
  `from: EMAIL_FROM`). A small plain-text + HTML template. **Dev fallback:** if
  `RESEND_API_KEY` is unset, don't call Resend — `console.log` the link and (dev only)
  include it in the `/v1/auth/login` response so local testing works without email.
- `src/d1.ts` — add a `users` store (upsertByEmail, getById), a `sessions` store
  (create, resolve, delete), and a `loginTokens` store (create, consume). Extend the
  `keys` store to write/read `user_id` + `label`.
- `src/index.ts` — route the four `/v1/auth/*` + `/v1/me` paths; wrap the gated
  endpoints with principal resolution.
- `src/types.ts` — new `User`, `Session` types; extend stores.

## Frontend (`public/index.html`)

- **New `#/login` view** (`view-login`): email input, "Send me a link" button →
  `POST /v1/auth/login`; success state ("Check your email"); in dev, if the response
  carries the link, show a "Dev: open link" affordance. Error state for `?error=…`.
- **Session-aware routing:** on load, call `GET /v1/me`. The router marks
  `#/playground`, `#/library`, `#/account` as gated; navigating to a gated route while
  logged out redirects to `#/login` (remembering the intended route to return to after
  verify). Public routes render regardless.
- **Nav/account:** show the signed-in email + a "Log out" action (`POST /v1/auth/logout`)
  when authenticated; show "Log in" otherwise. The account page's "Generate key" button
  now works only when logged in and lists the user's keys (labels + created_at; raw key
  shown once at creation). Existing CTAs ("Launch playground →", "Bind your keys") route
  through login when logged out.
- **Telemetry counters** remain client-side/`localStorage` for now (out of scope to move
  server-side). The "Credentials" card keeps the local BYOK/HF token note.

## Config / secrets

- `RESEND_API_KEY` — Resend API key (`wrangler secret put`). Unset ⇒ dev/console mode.
- `EMAIL_FROM` — e.g. `login@wagmi.photos` (verified Resend sending domain). `[vars]`.
- Reuses existing `PUBLIC_SITE_URL` to build absolute verify links.
- `MASTER_API_KEY` retained as the admin escape hatch.

## Local dev

- No `RESEND_API_KEY`: `/v1/auth/login` logs the magic link to the Worker console and
  returns it in the JSON so the flow is testable without email. The verify cookie omits
  `Secure` on plain-HTTP localhost.
- The seeded demo library (`.claude/skills/running-locally`) still works; browsing it now
  requires a dev login (get the link from the console). `MASTER_API_KEY`-unset keeps the
  **API** lane open for offline `curl` testing of generations.

## Security considerations

- Tokens: 32 bytes CSPRNG (`crypto.getRandomValues`); only SHA-256 hashes persisted;
  login tokens single-use + 15-min TTL; sessions 30-day sliding, revocable on logout.
- Cookies: `HttpOnly` (no JS access), `Secure` in prod, `SameSite=Lax` (allows the
  top-level redirect from the emailed link while blocking cross-site POST CSRF; state-
  changing POSTs — logout, keygen — additionally require the cookie, and are Lax-safe).
- No account enumeration: `/v1/auth/login` and `/v1/auth/verify` return generic results.
- Rate limiting on login (per email + IP) to throttle link spam / brute force.
- Constant-time compare retained for `MASTER_API_KEY`.

## Testing

Extend the vitest suites (offline, faked D1/rate-limiter/email):

- `session` unit: cookie parse/serialize; create → resolve → expire → revoke;
  sliding renewal; tampered/expired tokens rejected.
- `email` unit: Resend payload shape; dev fallback returns/logs link when key unset.
- Auth routes: `login` always 200 + no enumeration; rate-limit path still 200;
  `verify` happy path sets cookie + upserts user + single-use (second use fails);
  expired/used/unknown token → redirect with generic error; `me` 200/401; `logout`
  clears session.
- Gating: gated endpoints `401` without a principal; pass with a session cookie; pass
  with a user-owned key; ownerless key rejected; `MASTER_API_KEY` admin lane works.
- `keys/generate` requires a session and stamps `user_id`.
- D1 stores: user upsert-by-email idempotency; session/login-token lifecycle;
  `api_keys` migration drops ownerless rows.

## Out of scope / follow-ups

- Billing and plan entitlement enforcement (Free/Pro/BYOK gating).
- Social OAuth as an additional login method.
- Server-side telemetry/usage per user; "sign out everywhere"; teams/orgs.
- Moving BYOK credentials server-side (still browser-local for now).
