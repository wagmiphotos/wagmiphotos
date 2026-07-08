# BYOK self-serve generation — design (2026-07-09)

Users bring their own OpenAI or GMI Cloud API key, enable fresh generation for
their own requests, control when it fires, cap how many images per month, and
see an estimated spend. Generated images join the shared library.

## Product decisions

- **Who:** any signed-in user. BYOK is orthogonal to the $24/yr Unlimited plan —
  the plan keeps gating the bearer API (402 unchanged); BYOK never substitutes
  for it. A free user uses BYOK from the session playground; a subscriber's
  bearer calls use it too.
- **Where generation runs:** in the worker, in-request. This is the first
  exception to "the worker never generates" — justified because the user funds
  the compute, the trigger is their own request, and it works even while the
  backfill box is down. The demand-queue/backfill path is unchanged for
  non-BYOK traffic.
- **Trigger:** below tolerance. With BYOK enabled, any result that would have
  been `approximate` or `pending` generates fresh instead. Hits are untouched.
  The existing per-request `generate_on_miss` flag is the kill switch — when
  false, the key never fires. No new request parameters; the tolerance slider
  remains the user's "when" control.
- **Cap & spend:** per-user monthly image-count cap (default 50). Spend shown
  as an explicit *estimate*: count × per-provider price constant. No provider
  billing API integration.
- **Library:** generated images enter the shared public library after
  fail-closed in-worker prompt moderation (denylist + OpenAI moderation
  endpoint). They are subject to the same tombstone/takedown machinery as
  backfill assets (0008).
- **Models:** fixed per provider, pinned in `contract.json` — `openai →
  gpt-image-1`, `gmicloud → gpt-image-2-generate`. No model picker (matches
  existing API shape).

## Data model — migration `0013_byok.sql`

Two new tables (not columns on `users`: the key is an optional 1:0..1 and
usage is per-month):

```sql
byok_keys (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  provider       TEXT NOT NULL,            -- 'openai' | 'gmicloud'
  key_ciphertext TEXT NOT NULL,            -- base64(iv || AES-256-GCM(key))
  key_last4      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  monthly_cap    INTEGER NOT NULL DEFAULT 50,
  last_error     TEXT,                     -- e.g. 'provider_auth_failed'
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
)

byok_usage (
  user_id       TEXT NOT NULL,
  month         TEXT NOT NULL,             -- 'YYYY-MM' (UTC)
  count         INTEGER NOT NULL DEFAULT 0,
  est_spend_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
)
```

One key per user; switching provider replaces the row. `est_spend_usd`
accumulates at generation time using the price constant then in effect, so
later price edits don't rewrite history.

## Crypto — `src/crypto.ts`

First reversible secret we store (everything else is one-way hashed), so it
gets its own primitive:

- AES-256-GCM via `crypto.subtle`; KEK from new worker secret `BYOK_KEK`
  (32 random bytes, base64).
- Fresh 12-byte IV per encryption; stored as `base64(iv || ciphertext)`.
- Decrypt only inside the generation path. No endpoint returns the key;
  clients see `key_last4` only.

## Config

- New worker secrets: `BYOK_KEK`; `OPENAI_API_KEY` (moderation for
  gmicloud-key users — openai-key users are moderated with their own key;
  the moderation endpoint is free either way).
- `contract.json` additions: per-provider `{ model, price_per_image_usd }`;
  the denylist moves here so worker (TS) and backfill (Python) share one
  source of truth.
- New R2 bucket binding `BYOK_ORIGINALS` with a public URL for freshly
  generated originals. No B2 credentials in the worker.

## Generation flow (`src/handler.ts` + new `src/byok.ts`)

Existing flow unchanged through embed → shard query → floor check. Hits
return as today. When the result would be `approximate` or `pending` AND the
user has an enabled key AND `generate_on_miss` is true:

1. **Denylist + moderation, fail-closed.** Flagged → `400 content_policy`,
   nothing generated or counted. Moderation API unreachable → skip generation,
   fall back to today's approximate/pending response (fail closed for
   generation, not for the request).
2. **Reserve quota atomically:** upsert the month row, then
   `UPDATE byok_usage SET count = count + 1 WHERE user_id = ? AND month = ?
   AND count < ?`. Zero rows → cap reached → fall back to today's behavior
   with `byok: { status: "cap_reached" }` in the response.
3. **Call the provider** with the decrypted key and pinned model, ~60s
   timeout. OpenAI returns base64 JSON; GMI per its API.
4. **Persist:** put original bytes into `BYOK_ORIGINALS` (R2); insert asset
   row with `source_url` = R2 public URL, provider + price columns (0009),
   state not-locally-cached; upsert the prompt's BGE vector into its
   fnv1a32%3 shard. Derived thumb/medium/large arrive later via the existing
   demand-first rehost pipeline — asset-urls.ts already serves `source_url`
   until then. Zero new pipeline code.
5. **Respond** `result: "generated"` with the normal `data` shape plus
   `byok: { used, cap, est_spend_usd }`; accumulate `est_spend_usd`.

**Failure handling:** any failure after the reserve (provider error, timeout,
R2 put) refunds the counter and falls back to the approximate/pending
response with `byok: { status: "provider_error" }` — a broken key never
breaks the request. Provider `401` additionally writes `last_error` and sets
`enabled = 0` so the account page shows "key rejected" instead of silently
failing every subsequent call.

The fulfilled query is recorded as satisfied (no lingering demand row for the
backfill to duplicate).

## Key-management API — session-cookie only

Keys are managed from the account page, never with a bearer key:

- `PUT /v1/byok` — `{ provider, api_key, monthly_cap?, enabled? }`. Validates
  the key with a cheap authenticated provider ping before storing (OpenAI:
  `GET /v1/models`; GMI: its equivalent list/whoami endpoint — pinned in the
  plan); stores ciphertext + last4; clears `last_error`.
- `PATCH /v1/byok` — toggle `enabled` / change `monthly_cap` without
  re-entering the key.
- `DELETE /v1/byok` — remove key and settings (usage history rows remain).
- Status rides on `GET /v1/me` as `byok: { provider, key_last4, enabled,
  monthly_cap, used_this_month, est_spend_usd, price_per_image, last_error }`
  — one fetch drives the whole account card. Absent if no key.

## Account UI (`public/index.html`)

New "Bring your own key" card between Plan and Credentials, existing card
styling (light black/red):

- Provider select (OpenAI / GMI Cloud) + password-type key input; collapses
  to `••••` + last-4 once saved.
- **Enabled** toggle and **monthly cap** number input (PATCH on change).
- Usage meter: `12 / 50 images this month · est. $0.48 spent`, labelled
  *estimate*, with per-image price shown (`~$0.04/image via OpenAI`).
- Red "key rejected — re-enter it" banner when `last_error` is set; delete
  button underneath.

Playground: `result: "generated"` gets a badge ("✨ generated with your key")
and refreshes the meter from the response's `byok` block; `cap_reached` /
`provider_error` render one-line notices under the result. Tolerance slider
and `generate_on_miss` checkbox are unchanged — they already are the "when"
controls.

## Guardrails

- AUP acceptance (0010/0011) already gates every signed-in user; BYOK
  inherits it.
- Denylist + OpenAI moderation run fail-closed before any provider call.
- Free-session rate limiter (10/min) unchanged — provider latency
  self-throttles harder than the limiter.
- Generated assets are ordinary library assets: tombstones, takedowns, and
  rehost demand all apply.

## Testing

- Crypto roundtrip + tampered-ciphertext → decrypt failure.
- Cap reserve/refund atomicity — concurrent requests cannot overshoot by
  construction (single-statement guard).
- Trigger matrix: hit / approximate / pending × byok enabled/disabled ×
  `generate_on_miss` true/false.
- Moderation fail-closed (flagged → 400; unreachable → no generation).
- Provider 401 → auto-disable + `last_error`; refund on R2 failure.
- Endpoint auth: bearer key must NOT manage keys; session must; `/v1/me`
  shape with and without a key.
- Provider + moderation HTTP mocked like the Stripe tests.
- `scripts/local-byok-smoke.py` (pattern of `local-billing-smoke.py`) against
  `wrangler dev` with a real test OpenAI key — the provider call works
  locally; the Vectorize upsert needs a dev-mode skip (same offline caveat as
  today).

## Known limitations (accepted)

- Spend is an estimate, not the provider's bill; the price constant can
  drift from provider pricing until updated in `contract.json`.
- Output-image moderation is not performed (prompt-level only) — parity with
  the backfill's guardrails.
- One key per user (no per-provider multi-key store) — YAGNI until asked for.
- Month boundary is UTC calendar month.
