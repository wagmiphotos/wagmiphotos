# User Accounts + Magic-Link Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real user identity to wagmi.photos via passwordless email magic-link login, gating the playground/library/account and the API behind an authenticated user, and replacing anonymous API keys with user-owned keys.

**Architecture:** A Cloudflare Worker handles two auth lanes — an HttpOnly session cookie for humans (the SPA) and a user-owned Bearer key for programmatic clients. Login is a magic link emailed via Resend; sessions and single-use login tokens live in D1 (only SHA-256 hashes stored). New backend logic is split into focused modules (`session.ts`, `email.ts`, `auth-routes.ts`), with D1 access added to `d1.ts`.

**Tech Stack:** TypeScript, Cloudflare Workers (`wrangler` 3.x), D1 (SQLite), Vitest, Resend HTTP API, Web Crypto (`crypto.subtle`, `crypto.getRandomValues`).

## Global Constraints

- New D1 migration is `0004` (existing are `0001`–`0003`).
- Store only SHA-256 hashes of login tokens and session tokens — never raw values. Reuse `sha256Hex` from `src/auth.ts`.
- Login tokens: single-use, 15-minute TTL. Sessions: 30-day sliding TTL, revocable.
- Session cookie name is `wagmi_session`; flags `HttpOnly; SameSite=Lax; Path=/`; add `Secure` only when the request is HTTPS (so plain-HTTP localhost dev works).
- No account enumeration: `POST /v1/auth/login` and `GET /v1/auth/verify` return generic results regardless of whether the email/token is known.
- Emails are normalized (trimmed + lowercased) everywhere before hashing/lookup.
- Anonymous key minting is removed: `POST /v1/keys/generate` requires a session; keys are stored with `user_id`.
- Dev-open API lane is preserved ONLY for the API endpoints and ONLY when `MASTER_API_KEY` is unset (offline `curl` testing). Human page gating always requires a real session.
- Sentinel user ids: `MASTER_USER_ID = "usr_master"`, `DEV_USER_ID = "usr_dev"`.
- Tests are offline Vitest; D1 is faked with the `fakeDb(firstResult, allResults)` SQL-shape pattern (assert SQL text + bound args), global `fetch` stubbed with `vi.stubGlobal`.

---

### Task 1: D1 migration 0004 (accounts schema)

**Files:**
- Create: `projects/worker/migrations/0004_accounts.sql`

**Interfaces:**
- Produces: tables `users`, `login_tokens`, `sessions`; columns `api_keys.user_id`, `api_keys.label`.

- [ ] **Step 1: Write the migration**

Create `projects/worker/migrations/0004_accounts.sql`:

```sql
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
DELETE FROM api_keys WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
```

- [ ] **Step 2: Apply to the local D1 and verify the schema**

Run (from `projects/worker`):
```bash
npx wrangler d1 migrations apply sharedcache --local
npx wrangler d1 execute sharedcache --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name; PRAGMA table_info(api_keys);"
```
Expected: `users`, `login_tokens`, `sessions` present; `api_keys` lists `user_id` and `label` columns.

- [ ] **Step 3: Commit**

```bash
git add projects/worker/migrations/0004_accounts.sql
git commit -m "feat(auth): add D1 migration 0004 for users, sessions, login tokens"
```

---

### Task 2: D1 stores + types for users/sessions/login-tokens/keys

**Files:**
- Modify: `projects/worker/src/types.ts`
- Modify: `projects/worker/src/d1.ts`
- Test: `projects/worker/test/d1.test.ts`

**Interfaces:**
- Consumes: the migration 0004 schema.
- Produces:
  - `User { id: string; email: string; created_at: string; last_login: string | null }`
  - `UserStore { upsertByEmail(id: string, email: string): Promise<{ id: string; email: string }>; getById(id: string): Promise<User | null> }`
  - `SessionStore { create(userId: string, tokenHash: string): Promise<void>; resolve(tokenHash: string): Promise<{ user_id: string } | null>; touch(tokenHash: string): Promise<void>; delete(tokenHash: string): Promise<void> }`
  - `LoginTokenStore { create(tokenHash: string, email: string): Promise<void>; consume(tokenHash: string): Promise<{ email: string } | null> }`
  - `KeyStore { getKeyOwner(hash: string): Promise<string | null>; addKey(hash: string, userId: string, label: string | null): Promise<void>; listByUser(userId: string): Promise<{ label: string | null; created_at: string }[]> }`
  - `makeD1Stores(db)` additionally returns `{ users, sessions, loginTokens }` and the new `keys` shape.

- [ ] **Step 1: Update types in `src/types.ts`**

Replace the existing `KeyStore` interface and add the new ones. Change `KeyStore` from:
```ts
export interface KeyStore { verifyKey(hash: string): Promise<boolean>; addKey(hash: string): Promise<void>; }
```
to:
```ts
export interface User { id: string; email: string; created_at: string; last_login: string | null; }
export interface UserStore {
  upsertByEmail(id: string, email: string): Promise<{ id: string; email: string }>;
  getById(id: string): Promise<User | null>;
}
export interface SessionStore {
  create(userId: string, tokenHash: string): Promise<void>;
  resolve(tokenHash: string): Promise<{ user_id: string } | null>;
  touch(tokenHash: string): Promise<void>;
  delete(tokenHash: string): Promise<void>;
}
export interface LoginTokenStore {
  create(tokenHash: string, email: string): Promise<void>;
  consume(tokenHash: string): Promise<{ email: string } | null>;
}
export interface KeyStore {
  getKeyOwner(hash: string): Promise<string | null>;
  addKey(hash: string, userId: string, label: string | null): Promise<void>;
  listByUser(userId: string): Promise<{ label: string | null; created_at: string }[]>;
}
```
Extend `Services` to add the stores + email sender (email interface defined in Task 5; import it):
```ts
import type { EmailSender } from "./email";
// ...
export interface Services {
  clip: Clip; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore;
  keys: KeyStore; rateLimiter: RateLimiter;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  email: EmailSender;
}
```
Extend `Env` with the two new config fields:
```ts
export interface Env {
  // ...existing fields...
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
}
```

> Note: `EmailSender` is created in Task 5. To keep Task 2 compiling in isolation, add a temporary local `export interface EmailSender { sendMagicLink(email: string, link: string): Promise<void>; }` to `types.ts` now, and in Task 5 move it to `email.ts` and import it. (This is the one forward-declared type.)

- [ ] **Step 2: Write failing tests for the new stores in `test/d1.test.ts`**

Append (the file already defines `fakeDb`):
```ts
it("users.upsertByEmail inserts with ON CONFLICT and returns id/email", async () => {
  const { db, calls } = fakeDb({ id: "usr_1", email: "a@b.co" });
  const { users } = makeD1Stores(db);
  const u = await users.upsertByEmail("usr_1", "a@b.co");
  expect(u).toEqual({ id: "usr_1", email: "a@b.co" });
  expect(calls[0].sql).toContain("INSERT INTO users");
  expect(calls[0].sql).toContain("ON CONFLICT(email)");
  expect(calls[0].sql).toContain("RETURNING id, email");
  expect(calls[0].args).toEqual(["usr_1", "a@b.co"]);
});

it("sessions.create/resolve/touch/delete hit sessions with TTL and expiry guard", async () => {
  const { db, calls } = fakeDb({ user_id: "usr_1" });
  const { sessions } = makeD1Stores(db);
  await sessions.create("usr_1", "h1");
  expect(calls[0].sql).toContain("INSERT INTO sessions");
  expect(calls[0].sql).toContain("+30 days");
  expect(calls[0].args).toEqual(["usr_1", "h1"]);
  const r = await sessions.resolve("h1");
  expect(r).toEqual({ user_id: "usr_1" });
  expect(calls[1].sql).toContain("expires_at > datetime('now')");
  await sessions.touch("h1");
  expect(calls[2].sql).toContain("UPDATE sessions SET expires_at");
  await sessions.delete("h1");
  expect(calls[3].sql).toContain("DELETE FROM sessions");
});

it("loginTokens.create sets 15-min TTL; consume is single-use + expiry-guarded", async () => {
  const { db, calls } = fakeDb({ email: "a@b.co" });
  const { loginTokens } = makeD1Stores(db);
  await loginTokens.create("h1", "a@b.co");
  expect(calls[0].sql).toContain("INSERT INTO login_tokens");
  expect(calls[0].sql).toContain("+15 minutes");
  const c = await loginTokens.consume("h1");
  expect(c).toEqual({ email: "a@b.co" });
  expect(calls[1].sql).toContain("UPDATE login_tokens SET used_at");
  expect(calls[1].sql).toContain("used_at IS NULL");
  expect(calls[1].sql).toContain("expires_at > datetime('now')");
  expect(calls[1].sql).toContain("RETURNING email");
});

it("keys.getKeyOwner/addKey/listByUser use api_keys with user_id", async () => {
  const { db, calls } = fakeDb({ user_id: "usr_1" }, [{ label: "cli", created_at: "2026-07-06" }]);
  const { keys } = makeD1Stores(db);
  expect(await keys.getKeyOwner("hX")).toBe("usr_1");
  expect(calls[0].sql).toContain("SELECT user_id FROM api_keys");
  await keys.addKey("hY", "usr_1", "cli");
  expect(calls[1].sql).toContain("INSERT OR IGNORE INTO api_keys");
  expect(calls[1].args).toEqual(["hY", "usr_1", "cli"]);
  const list = await keys.listByUser("usr_1");
  expect(list).toEqual([{ label: "cli", created_at: "2026-07-06" }]);
  expect(calls[2].sql).toContain("WHERE user_id = ?");
});
```
Also update the existing test `"verifyKey and addKey hit api_keys"` — replace it with the `getKeyOwner` test above (delete the old one; `verifyKey` no longer exists).

- [ ] **Step 2b: Run tests to verify they fail**

Run: `npx vitest run test/d1.test.ts`
Expected: FAIL (`users`, `sessions`, `loginTokens` undefined; `getKeyOwner` not a function).

- [ ] **Step 3: Implement the stores in `src/d1.ts`**

Change `makeD1Stores`'s return type and body. Replace the `keys` store and add the three new stores:
```ts
export function makeD1Stores(db: any): {
  assets: AssetStore; queries: QueryStore; keys: KeyStore;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
} {
  // ...existing assets + queries unchanged...

  const keys: KeyStore = {
    async getKeyOwner(hash) {
      const row = await db.prepare("SELECT user_id FROM api_keys WHERE key_hash = ?").bind(hash).first();
      return (row?.user_id as string) ?? null;
    },
    async addKey(hash, userId, label) {
      await db.prepare("INSERT OR IGNORE INTO api_keys (key_hash, user_id, label) VALUES (?, ?, ?)")
        .bind(hash, userId, label).run();
    },
    async listByUser(userId) {
      const { results } = await db.prepare(
        "SELECT label, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
      ).bind(userId).all();
      return (results ?? []) as { label: string | null; created_at: string }[];
    },
  };

  const users: UserStore = {
    async upsertByEmail(id, email) {
      const row = await db.prepare(
        `INSERT INTO users (id, email) VALUES (?, ?)
         ON CONFLICT(email) DO UPDATE SET last_login = datetime('now')
         RETURNING id, email`
      ).bind(id, email).first();
      return row as { id: string; email: string };
    },
    async getById(id) {
      const row = await db.prepare("SELECT id, email, created_at, last_login FROM users WHERE id = ?").bind(id).first();
      return (row as User) ?? null;
    },
  };

  const sessions: SessionStore = {
    async create(userId, tokenHash) {
      await db.prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
      ).bind(tokenHash, userId).run();
    },
    async resolve(tokenHash) {
      const row = await db.prepare(
        "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')"
      ).bind(tokenHash).first();
      return row ? { user_id: row.user_id as string } : null;
    },
    async touch(tokenHash) {
      await db.prepare("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE token_hash = ?").bind(tokenHash).run();
    },
    async delete(tokenHash) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    },
  };

  const loginTokens: LoginTokenStore = {
    async create(tokenHash, email) {
      await db.prepare(
        "INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))"
      ).bind(tokenHash, email).run();
    },
    async consume(tokenHash) {
      const row = await db.prepare(
        `UPDATE login_tokens SET used_at = datetime('now')
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
         RETURNING email`
      ).bind(tokenHash).first();
      return row ? { email: row.email as string } : null;
    },
  };

  return { assets, queries, keys, users, sessions, loginTokens };
}
```
Add `import type { ..., User, UserStore, SessionStore, LoginTokenStore } from "./types";` at the top (extend the existing import line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/d1.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/test/d1.test.ts
git commit -m "feat(auth): D1 stores for users, sessions, login tokens, owned keys"
```

---

### Task 3: Session cookie utilities + token generation (`session.ts`)

**Files:**
- Create: `projects/worker/src/session.ts`
- Test: `projects/worker/test/session.test.ts`

**Interfaces:**
- Produces:
  - `randomToken(bytes?: number): string` — base64url CSPRNG token.
  - `parseCookies(header: string | null): Record<string, string>`
  - `SESSION_COOKIE = "wagmi_session"`
  - `serializeSessionCookie(token: string, secure: boolean): string`
  - `clearSessionCookie(secure: boolean): string`
  - `isSecureRequest(request: Request): boolean`

- [ ] **Step 1: Write failing tests in `test/session.test.ts`**

```ts
import { it, expect } from "vitest";
import { randomToken, parseCookies, serializeSessionCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE } from "../src/session";

it("randomToken is url-safe and unique", () => {
  const a = randomToken(), b = randomToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(a).not.toBe(b);
  expect(a.length).toBeGreaterThan(20);
});

it("parseCookies splits name=value pairs and tolerates blanks", () => {
  expect(parseCookies("a=1; wagmi_session=xyz; b=2")).toMatchObject({ a: "1", wagmi_session: "xyz", b: "2" });
  expect(parseCookies(null)).toEqual({});
  expect(parseCookies("")).toEqual({});
});

it("serializeSessionCookie sets HttpOnly, SameSite=Lax, Path, and Secure only when asked", () => {
  const secure = serializeSessionCookie("tok", true);
  expect(secure).toContain(`${SESSION_COOKIE}=tok`);
  expect(secure).toContain("HttpOnly");
  expect(secure).toContain("SameSite=Lax");
  expect(secure).toContain("Path=/");
  expect(secure).toContain("Secure");
  expect(serializeSessionCookie("tok", false)).not.toContain("Secure");
});

it("clearSessionCookie expires the cookie", () => {
  expect(clearSessionCookie(true)).toContain("Max-Age=0");
});

it("isSecureRequest reflects the URL scheme", () => {
  expect(isSecureRequest(new Request("https://x/"))).toBe(true);
  expect(isSecureRequest(new Request("http://localhost:8787/"))).toBe(false);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/session.ts`**

```ts
export const SESSION_COOKIE = "wagmi_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_TTL_SECONDS}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/session.ts projects/worker/test/session.test.ts
git commit -m "feat(auth): session cookie utilities and CSPRNG token generation"
```

---

### Task 4: Principal resolution (session + API lanes)

**Files:**
- Modify: `projects/worker/src/session.ts`
- Modify: `projects/worker/src/auth.ts` (remove `checkAuth`; keep `sha256Hex`, `constantTimeEqual`, `bearer` export)
- Test: `projects/worker/test/session.test.ts` (add), `projects/worker/test/auth.test.ts` (retire `checkAuth` cases)

**Interfaces:**
- Consumes: `SessionStore`, `KeyStore`, `sha256Hex`, `constantTimeEqual`.
- Produces:
  - `MASTER_USER_ID = "usr_master"`, `DEV_USER_ID = "usr_dev"`
  - `resolveSession(request, env, sessions): Promise<{ userId: string } | null>` — cookie only; slides TTL on hit.
  - `resolveApiPrincipal(request, env, stores): Promise<{ userId: string } | null>` — master key OR owned bearer key OR session cookie OR (dev-open `usr_dev` when `MASTER_API_KEY` unset).

- [ ] **Step 1: Export `bearer` from `auth.ts`**

In `src/auth.ts`, change `function bearer(...)` to `export function bearer(...)`, and delete `checkAuth` (moved/renamed to `resolveApiPrincipal`). Leave `sha256Hex`/`constantTimeEqual` intact.

- [ ] **Step 2: Write failing tests in `test/session.test.ts`**

```ts
import { resolveSession, resolveApiPrincipal, MASTER_USER_ID, DEV_USER_ID } from "../src/session";
import { sha256Hex } from "../src/auth";

function reqWith({ cookie, bearer }: { cookie?: string; bearer?: string } = {}) {
  const h: Record<string, string> = {};
  if (cookie) h["Cookie"] = cookie;
  if (bearer) h["Authorization"] = `Bearer ${bearer}`;
  return new Request("https://x/v1/images/generations", { method: "POST", headers: h });
}
function fakeStores(over: any = {}) {
  return {
    sessions: { resolve: async () => null, touch: async () => {}, create: async () => {}, delete: async () => {} },
    keys: { getKeyOwner: async () => null, addKey: async () => {}, listByUser: async () => [] },
    ...over,
  };
}

it("resolveSession returns user from a valid cookie and slides TTL", async () => {
  let touched = "";
  const stores = fakeStores({ sessions: { resolve: async () => ({ user_id: "usr_9" }), touch: async (h: string) => { touched = h; } } });
  const r = await resolveSession(reqWith({ cookie: "wagmi_session=tok" }), {} as any, stores.sessions);
  expect(r).toEqual({ userId: "usr_9" });
  expect(touched).toBe(await sha256Hex("tok"));
});

it("resolveSession returns null without a cookie", async () => {
  expect(await resolveSession(reqWith(), {} as any, fakeStores().sessions)).toBeNull();
});

it("resolveApiPrincipal: master key wins", async () => {
  const r = await resolveApiPrincipal(reqWith({ bearer: "master" }), { MASTER_API_KEY: "master" } as any, fakeStores());
  expect(r).toEqual({ userId: MASTER_USER_ID });
});

it("resolveApiPrincipal: owned bearer key resolves to its owner", async () => {
  const stores = fakeStores({ keys: { getKeyOwner: async () => "usr_7", addKey: async () => {}, listByUser: async () => [] } });
  const r = await resolveApiPrincipal(reqWith({ bearer: "sc-x" }), { MASTER_API_KEY: "master" } as any, stores);
  expect(r).toEqual({ userId: "usr_7" });
});

it("resolveApiPrincipal: ownerless key -> null (rejected)", async () => {
  const r = await resolveApiPrincipal(reqWith({ bearer: "sc-x" }), { MASTER_API_KEY: "master" } as any, fakeStores());
  expect(r).toBeNull();
});

it("resolveApiPrincipal: cookie session also accepted (browser playground)", async () => {
  const stores = fakeStores({ sessions: { resolve: async () => ({ user_id: "usr_3" }), touch: async () => {} } });
  const r = await resolveApiPrincipal(reqWith({ cookie: "wagmi_session=tok" }), { MASTER_API_KEY: "master" } as any, stores);
  expect(r).toEqual({ userId: "usr_3" });
});

it("resolveApiPrincipal: dev-open when MASTER_API_KEY unset", async () => {
  const r = await resolveApiPrincipal(reqWith(), {} as any, fakeStores());
  expect(r).toEqual({ userId: DEV_USER_ID });
});
```
In `test/auth.test.ts`, delete the three `checkAuth` cases (`open when MASTER_API_KEY unset`, `accepts master key...`, `accepts a db-registered hashed key`) — this behavior is now covered by `resolveApiPrincipal` above. Keep the `sha256Hex` and `constantTimeEqual` tests.

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run test/session.test.ts test/auth.test.ts`
Expected: FAIL (`resolveSession`/`resolveApiPrincipal` undefined).

- [ ] **Step 4: Implement in `src/session.ts`**

Append:
```ts
import type { Env, SessionStore, KeyStore } from "./types";
import { sha256Hex, constantTimeEqual, bearer } from "./auth";

export const MASTER_USER_ID = "usr_master";
export const DEV_USER_ID = "usr_dev";

export async function resolveSession(request: Request, _env: Env, sessions: SessionStore): Promise<{ userId: string } | null> {
  const raw = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const row = await sessions.resolve(hash);
  if (!row) return null;
  await sessions.touch(hash);
  return { userId: row.user_id };
}

export async function resolveApiPrincipal(
  request: Request, env: Env, stores: { sessions: SessionStore; keys: KeyStore }
): Promise<{ userId: string } | null> {
  const token = bearer(request);
  if (token) {
    if (env.MASTER_API_KEY && constantTimeEqual(await sha256Hex(token), await sha256Hex(env.MASTER_API_KEY))) {
      return { userId: MASTER_USER_ID };
    }
    const owner = await stores.keys.getKeyOwner(await sha256Hex(token));
    if (owner) return { userId: owner };
    // a presented-but-unowned key is an explicit failure; fall through to cookie/dev
  }
  const session = await resolveSession(request, env, stores.sessions);
  if (session) return session;
  if (!env.MASTER_API_KEY) return { userId: DEV_USER_ID }; // dev-open API lane
  return null;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/session.test.ts test/auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/session.ts projects/worker/src/auth.ts projects/worker/test/session.test.ts projects/worker/test/auth.test.ts
git commit -m "feat(auth): principal resolution for session + API lanes"
```

---

### Task 5: Email module (Resend + dev fallback)

**Files:**
- Create: `projects/worker/src/email.ts`
- Modify: `projects/worker/src/types.ts` (remove the temporary `EmailSender` forward-decl from Task 2; import it from `email.ts`)
- Test: `projects/worker/test/email.test.ts`

**Interfaces:**
- Produces:
  - `EmailSender { sendMagicLink(email: string, link: string): Promise<void> }`
  - `makeEmailSender(env: Env): EmailSender`
  - `emailIsDevMode(env: Env): boolean` (true when `RESEND_API_KEY` unset)

- [ ] **Step 1: Write failing tests in `test/email.test.ts`**

```ts
import { it, expect, vi, afterEach } from "vitest";
import { makeEmailSender, emailIsDevMode } from "../src/email";

afterEach(() => vi.unstubAllGlobals());

it("dev mode when RESEND_API_KEY unset: logs, does not fetch", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  expect(emailIsDevMode({} as any)).toBe(true);
  await makeEmailSender({} as any).sendMagicLink("a@b.co", "https://x/link");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

it("prod mode posts to Resend with from/to/subject", async () => {
  let captured: any = null;
  vi.stubGlobal("fetch", async (url: string, init: any) => { captured = { url, init }; return new Response("{}", { status: 200 }); });
  await makeEmailSender({ RESEND_API_KEY: "re_x", EMAIL_FROM: "login@wagmi.photos" } as any).sendMagicLink("a@b.co", "https://x/link");
  expect(captured.url).toBe("https://api.resend.com/emails");
  expect(captured.init.headers.Authorization).toBe("Bearer re_x");
  const body = JSON.parse(captured.init.body);
  expect(body.from).toBe("login@wagmi.photos");
  expect(body.to).toBe("a@b.co");
  expect(body.text).toContain("https://x/link");
});

it("prod mode throws on non-2xx", async () => {
  vi.stubGlobal("fetch", async () => new Response("bad", { status: 422 }));
  await expect(makeEmailSender({ RESEND_API_KEY: "re_x", EMAIL_FROM: "f@x" } as any).sendMagicLink("a@b.co", "l")).rejects.toThrow(/Resend failed/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/email.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/email.ts`**

```ts
import type { Env } from "./types";

export interface EmailSender { sendMagicLink(email: string, link: string): Promise<void>; }

export function emailIsDevMode(env: Env): boolean { return !env.RESEND_API_KEY; }

export function makeEmailSender(env: Env): EmailSender {
  return {
    async sendMagicLink(email, link) {
      if (!env.RESEND_API_KEY) {
        console.log(`[dev] magic link for ${email}: ${link}`);
        return;
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: email,
          subject: "Your wagmi.photos login link",
          text: `Log in to wagmi.photos:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
          html: `<p>Log in to wagmi.photos:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
        }),
      });
      if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
    },
  };
}
```
Then in `src/types.ts`, remove the temporary `EmailSender` interface added in Task 2 and instead `import type { EmailSender } from "./email";` (the `Services` interface already references it).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/email.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/email.ts projects/worker/src/types.ts projects/worker/test/email.test.ts
git commit -m "feat(auth): Resend email sender with dev console fallback"
```

---

### Task 6: Auth route handlers (`auth-routes.ts`)

**Files:**
- Create: `projects/worker/src/auth-routes.ts`
- Test: `projects/worker/test/auth-routes.test.ts`

**Interfaces:**
- Consumes: `Services` (uses `users`, `sessions`, `loginTokens`, `keys`, `rateLimiter`, `email`), `resolveSession`, `randomToken`, `serializeSessionCookie`, `clearSessionCookie`, `isSecureRequest`, `sha256Hex`, `emailIsDevMode`.
- Produces (all take `(…, env, services, cfg)` where `cfg = { now?, token?, verifyBase }`):
  - `handleLoginRequest(request, env, services, cfg): Promise<Response>`
  - `handleVerify(url, request, env, services, cfg): Promise<Response>`
  - `handleMe(request, env, services): Promise<Response>`
  - `handleLogout(request, env, services): Promise<Response>`
  - `handleListKeys(request, env, services): Promise<Response>`
  - `normalizeEmail(raw: string): string`, `isValidEmail(email: string): boolean`

- [ ] **Step 1: Write failing tests in `test/auth-routes.test.ts`**

```ts
import { it, expect } from "vitest";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, normalizeEmail, isValidEmail } from "../src/auth-routes";
import { sha256Hex } from "../src/auth";
import { serializeSessionCookie, SESSION_COOKIE } from "../src/session";

function svc(over: any = {}) {
  const sent: any[] = [];
  const created: any[] = [];
  const base = {
    users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) },
    sessions: { create: async (u: string, h: string) => { created.push({ u, h }); }, resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, delete: async () => {} },
    loginTokens: { create: async () => {}, consume: async () => ({ email: "a@b.co" }) },
    keys: { getKeyOwner: async () => null, addKey: async () => {}, listByUser: async () => [] },
    rateLimiter: { limit: async () => true },
    email: { sendMagicLink: async (e: string, l: string) => { sent.push({ e, l }); } },
  };
  const s = { ...base, ...over };
  (s as any)._sent = sent; (s as any)._created = created;
  return s as any;
}
const cfg = { token: () => "TOK", verifyBase: "https://wagmi.photos", now: () => 0 };
const loginReq = (email: any) => new Request("https://x/v1/auth/login", { method: "POST", body: JSON.stringify({ email }) });

it("normalizeEmail lowercases + trims; isValidEmail basic check", () => {
  expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
  expect(isValidEmail("a@b.co")).toBe(true);
  expect(isValidEmail("nope")).toBe(false);
});

it("login: 200 generic, sends link with token to normalized email", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("A@B.CO"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(res.status).toBe(200);
  expect(s._sent[0].e).toBe("a@b.co");
  expect(s._sent[0].l).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
});

it("login: invalid email -> 400", async () => {
  const res = await handleLoginRequest(loginReq("nope"), {} as any, svc(), cfg);
  expect(res.status).toBe(400);
});

it("login: rate-limited still returns generic 200 and does not send", async () => {
  const s = svc({ rateLimiter: { limit: async () => false } });
  const res = await handleLoginRequest(loginReq("a@b.co"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(res.status).toBe(200);
  expect(s._sent.length).toBe(0);
});

it("login: dev mode returns the link in the body", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("a@b.co"), {} as any, s, cfg); // no RESEND_API_KEY
  const j: any = await res.json();
  expect(j.dev_link).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
});

it("verify: valid token sets cookie + 302 to playground", async () => {
  const s = svc();
  const res = await handleVerify(new URL("https://x/v1/auth/verify?token=TOK"), new Request("https://x/v1/auth/verify?token=TOK"), {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://wagmi.photos/#/playground");
  expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=TOK`);
  expect(s._created[0].h).toBe(await sha256Hex("TOK"));
});

it("verify: consumed/expired token -> 302 to login with error", async () => {
  const s = svc({ loginTokens: { create: async () => {}, consume: async () => null } });
  const res = await handleVerify(new URL("https://x/v1/auth/verify?token=BAD"), new Request("https://x/v1/auth/verify?token=BAD"), {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("#/login?error=");
});

it("me: 200 with user when session resolves, 401 otherwise", async () => {
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=tok` } });
  const ok = await handleMe(req, {} as any, svc());
  expect(ok.status).toBe(200);
  const anon = await handleMe(new Request("https://x/v1/me"), {} as any, svc());
  expect(anon.status).toBe(401);
});

it("logout: clears cookie + deletes session", async () => {
  let deleted = "";
  const s = svc({ sessions: { resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, create: async () => {}, delete: async (h: string) => { deleted = h; } } });
  const res = await handleLogout(new Request("https://x/v1/auth/logout", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=tok` } }), {} as any, s);
  expect(res.status).toBe(200);
  expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(deleted).toBe(await sha256Hex("tok"));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/auth-routes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/auth-routes.ts`**

```ts
import type { Env, Services } from "./types";
import { sha256Hex } from "./auth";
import {
  randomToken, resolveSession, serializeSessionCookie, clearSessionCookie,
  isSecureRequest, parseCookies, SESSION_COOKIE,
} from "./session";
import { emailIsDevMode } from "./email";

export interface AuthCfg { token?: () => string; verifyBase: string; now?: () => number; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(raw: string): string { return raw.trim().toLowerCase(); }
export function isValidEmail(email: string): boolean { return email.length <= 254 && EMAIL_RE.test(email); }

function clientIp(request: Request): string { return request.headers.get("CF-Connecting-IP") ?? "unknown"; }
const genGeneric = () => Response.json({ status: "sent" });

export async function handleLoginRequest(request: Request, env: Env, s: Services, cfg: AuthCfg): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isValidEmail(email)) return Response.json({ error: "invalid email" }, { status: 400 });

  // Rate-limit by IP and by email; on limit, return the generic 200 without sending.
  const okIp = await s.rateLimiter.limit(`login:ip:${clientIp(request)}`);
  const okEmail = await s.rateLimiter.limit(`login:email:${email}`);
  if (!okIp || !okEmail) return genGeneric();

  const token = (cfg.token ?? randomToken)();
  await s.loginTokens.create(await sha256Hex(token), email);
  const link = `${cfg.verifyBase}/v1/auth/verify?token=${token}`;
  try { await s.email.sendMagicLink(email, link); } catch (e) { console.error("sendMagicLink failed", e); }

  // In dev (no email provider) return the link so local testing works.
  if (emailIsDevMode(env)) return Response.json({ status: "sent", dev_link: link });
  return genGeneric();
}

export async function handleVerify(url: URL, request: Request, env: Env, s: Services, cfg: AuthCfg): Promise<Response> {
  const loginFail = Response.redirect(`${cfg.verifyBase}/#/login?error=invalid_or_expired`, 302);
  const raw = url.searchParams.get("token");
  if (!raw) return loginFail;
  const consumed = await s.loginTokens.consume(await sha256Hex(raw));
  if (!consumed) return loginFail;

  const id = `usr_${randomToken(12)}`;
  const user = await s.users.upsertByEmail(id, consumed.email);
  const sessionToken = (cfg.token ?? randomToken)();
  await s.sessions.create(user.id, await sha256Hex(sessionToken));

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${cfg.verifyBase}/#/playground`,
      "Set-Cookie": serializeSessionCookie(sessionToken, isSecureRequest(request)),
    },
  });
}

export async function handleMe(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  const user = await s.users.getById(principal.userId);
  if (!user) return Response.json({ error: "not authenticated" }, { status: 401 });
  return Response.json({ user: { id: user.id, email: user.email } });
}

export async function handleLogout(request: Request, env: Env, s: Services): Promise<Response> {
  const raw = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (raw) await s.sessions.delete(await sha256Hex(raw));
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie(isSecureRequest(request)) },
  });
}

export async function handleListKeys(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  return Response.json({ keys: await s.keys.listByUser(principal.userId) });
}
```

> Note on `Response.redirect`: the `handleVerify` success path builds the `Response` manually (not `Response.redirect`) because it must attach `Set-Cookie`; the failure path uses `Response.redirect` for brevity. Both are 302.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/auth-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/auth-routes.ts projects/worker/test/auth-routes.test.ts
git commit -m "feat(auth): login/verify/me/logout/list-keys route handlers"
```

---

### Task 7: Wire routes + gating into the Worker

**Files:**
- Modify: `projects/worker/src/index.ts`
- Modify: `projects/worker/src/handler.ts` (`handleKeygen` takes a `userId`)
- Modify: `projects/worker/test/fakes.ts` (extend `fakeServices` with new stores + email)
- Test: `projects/worker/test/router.test.ts` (add), `projects/worker/test/handler.test.ts` (update keygen)

**Interfaces:**
- Consumes: `resolveApiPrincipal`, `resolveSession`, all Task 6 handlers, `makeD1Stores` (now returns the new stores), `makeEmailSender`.
- Produces: routed endpoints `/v1/auth/login`, `/v1/auth/verify`, `/v1/me`, `/v1/auth/logout`, `/v1/keys` (GET); gated `/v1/images/generations`, `/v1/library`, `/v1/library/:id/download`, `/v1/keys/generate`.

- [ ] **Step 1: Extend `fakeServices` in `test/fakes.ts`**

Add the new stores + email to the `base` object and update the `keys` store shape:
```ts
// replace the keys line:
keys: {
  getKeyOwner: async (h) => (keyOwners.get(h) ?? null),
  addKey: async (h, u) => { keyOwners.set(h, u); },
  listByUser: async () => [],
},
// add before `base`:
const keyOwners = new Map<string, string>();
// add to base:
users: { upsertByEmail: async (id, email) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) },
sessions: { create: async () => {}, resolve: async () => null, touch: async () => {}, delete: async () => {} },
loginTokens: { create: async () => {}, consume: async () => null },
email: { sendMagicLink: async () => {} },
```
Remove the old `keyHashes` set + `verifyKey`/`addKey(h)` usage. Update the exposed `_keyHashes` to `_keyOwners`.

- [ ] **Step 2: Write failing router tests in `test/router.test.ts`**

Extend `fakeEnv`'s `db` stub to return shaped rows for the new stores is unnecessary — these tests exercise routing/gating, so use `MASTER_API_KEY` and cookies. Add:
```ts
it("generate: 401 when gated and no principal (master set, no creds)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ MASTER_API_KEY: "master" })
  );
  expect(res.status).toBe(401);
});

it("library: now gated -> 401 without a principal when master set", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"), fakeEnv({ MASTER_API_KEY: "master" }));
  expect(res.status).toBe(401);
});

it("library: open in dev (no master) -> 200", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"), fakeEnv());
  expect(res.status).toBe(200);
});

it("auth/login: POST returns 200 generic (dev returns dev_link)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.co" }) }),
    fakeEnv()
  );
  expect(res.status).toBe(200);
});

it("me: 401 without cookie", async () => {
  const res = await worker.fetch(new Request("https://x/v1/me"), fakeEnv({ MASTER_API_KEY: "master" }));
  expect(res.status).toBe(401);
});

it("keys/generate: 401 without a session", async () => {
  const res = await worker.fetch(new Request("https://x/v1/keys/generate", { method: "POST" }), fakeEnv({ MASTER_API_KEY: "master" }));
  expect(res.status).toBe(401);
});
```
The `fakeEnv` `db` stub already returns `first: async () => null` (so `sessions.resolve` → null, `loginTokens.consume` → null). For `auth/login`, `loginTokens.create` uses `.run()` which the stub supports.

- [ ] **Step 3: Update `handleKeygen` in `src/handler.ts`**

Change signature to accept the owner and label:
```ts
export async function handleKeygen(request: Request, s: Services, genKey: () => string, userId: string): Promise<Response> {
  const ok = await s.rateLimiter.limit(clientIp(request));
  if (!ok) return Response.json({ error: "Too many key requests" }, { status: 429 });
  let label: string | null = null;
  try { const b: any = await request.json(); if (typeof b?.label === "string") label = b.label.slice(0, 80); } catch { /* body optional */ }
  const key = genKey();
  await s.keys.addKey(await sha256Hex(key), userId, label);
  return Response.json({ key, created_at: Math.floor(Date.now() / 1000) });
}
```
Update `test/handler.test.ts`'s keygen test to pass a `userId` and assert `addKey` got `(hash, userId, label)`.

- [ ] **Step 4: Wire `src/index.ts`**

In `buildServices`, add the new stores + email:
```ts
const { assets, queries, keys, users, sessions, loginTokens } = makeD1Stores(env.DB);
// ...
return { clip: {...}, vectorize: ..., assets, queries, keys, rateLimiter, users, sessions, loginTokens, email: makeEmailSender(env) };
```
Add imports:
```ts
import { makeEmailSender } from "./email";
import { resolveApiPrincipal, resolveSession } from "./session";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, handleListKeys } from "./auth-routes";
```
Add an `authCfg` helper inside `fetch`:
```ts
const verifyBase = env.PUBLIC_SITE_URL || "https://wagmi.photos";
const authCfg = { verifyBase };
```
Add routes (before the `/v1/` catch-all 404), removing the old `checkAuth` import/use:
```ts
if (url.pathname === "/v1/auth/login" && request.method === "POST")
  return await handleLoginRequest(request, env, buildServices(env), authCfg);
if (url.pathname === "/v1/auth/verify" && request.method === "GET")
  return await handleVerify(url, request, env, buildServices(env), authCfg);
if (url.pathname === "/v1/me" && request.method === "GET")
  return await handleMe(request, env, buildServices(env));
if (url.pathname === "/v1/auth/logout" && request.method === "POST")
  return await handleLogout(request, env, buildServices(env));
if (url.pathname === "/v1/keys" && request.method === "GET")
  return await handleListKeys(request, env, buildServices(env));
```
Change keygen to require a session:
```ts
if (url.pathname === "/v1/keys/generate" && request.method === "POST") {
  const services = buildServices(env);
  const principal = await resolveSession(request, env, services.sessions);
  if (!principal) return Response.json({ error: "login required" }, { status: 401 });
  return await handleKeygen(request, services, genKey, principal.userId);
}
```
Change generations gating from `checkAuth` to `resolveApiPrincipal`:
```ts
if (url.pathname === "/v1/images/generations" && request.method === "POST") {
  const services = buildServices(env);
  const principal = await resolveApiPrincipal(request, env, services);
  if (!principal) return Response.json({ error: "Invalid API Key" }, { status: 401 });
  const genIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await services.rateLimiter.limit(`gen:${principal.userId}`))) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  // ...unchanged body parse + cfg + handleGenerate...
}
```
Gate the library routes — wrap the two existing library handlers with a principal check:
```ts
if (url.pathname === "/v1/library" && request.method === "GET") {
  const services = buildServices(env);
  if (!(await resolveApiPrincipal(request, env, services))) return Response.json({ error: "login required" }, { status: 401 });
  return await handleLibrarySearch(url, services);
}
const dl = url.pathname.match(/^\/v1\/library\/([^/]+)\/download$/);
if (dl && request.method === "GET") {
  const services = buildServices(env);
  if (!(await resolveApiPrincipal(request, env, services))) return Response.json({ error: "login required" }, { status: 401 });
  // ...unchanged id decode + handleLibraryDownload...
}
```
Remove `import { checkAuth } from "./auth";`.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (existing suites + new). Fix any signature mismatches surfaced by `handleKeygen`/`fakeServices`.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/index.ts projects/worker/src/handler.ts projects/worker/test/fakes.ts projects/worker/test/router.test.ts projects/worker/test/handler.test.ts
git commit -m "feat(auth): route auth endpoints and gate product behind a principal"
```

---

### Task 8: Config — wrangler.toml + secrets docs

**Files:**
- Modify: `projects/worker/wrangler.toml`
- Modify: `.env.example`, `README.md` (auth section)

**Interfaces:**
- Produces: `EMAIL_FROM` var; documented `RESEND_API_KEY` secret.

- [ ] **Step 1: Add `EMAIL_FROM` to `[vars]` in `wrangler.toml`**

Under the existing `[vars]` block, add:
```toml
EMAIL_FROM = "login@wagmi.photos"   # verified Resend sending address
```
And extend the secrets comment:
```toml
# Secrets (set with `wrangler secret put`): MASTER_API_KEY, CLIP_EMBED_TOKEN, RESEND_API_KEY
```

- [ ] **Step 2: Document in `.env.example` and `README.md`**

Add to `.env.example`:
```
# --- Auth (magic-link login) ---
RESEND_API_KEY=          # unset locally → magic links log to console + return in the login response
EMAIL_FROM=login@wagmi.photos
```
Add a short "Authentication" subsection to `README.md` describing: magic-link login, that the playground/library/API require login, per-user keys, and the local dev flow (link in console). Note the `wrangler secret put RESEND_API_KEY` step for deploy.

- [ ] **Step 3: Commit**

```bash
git add projects/worker/wrangler.toml .env.example README.md
git commit -m "docs(auth): config for Resend + magic-link login"
```

---

### Task 9: Frontend — login view, gating, account page

**Files:**
- Modify: `projects/worker/public/index.html`

**Interfaces:**
- Consumes: `POST /v1/auth/login`, `GET /v1/me`, `POST /v1/auth/logout`, `GET /v1/keys`, `POST /v1/keys/generate`.

- [ ] **Step 1: Add the `#/login` route + gated-route set**

In the `ROUTES` map add:
```js
'#/login': { view: 'view-login' },
```
Above `showRoute`, add:
```js
const GATED = new Set(['#/playground', '#/library', '#/account']);
let currentUser = null;
```
In `showRoute(route)`, before resolving the view, add the gate:
```js
if (GATED.has(route) && !currentUser) {
  sessionStorage.setItem('wagmi_return', route);
  route = '#/login';
}
```

- [ ] **Step 2: Add the `view-login` markup**

Add a new `<div id="view-login" class="spa-view" style="display:none;">` (mirror the structure of `view-account`) containing: a centered card with an email `<input id="login-email" type="email">`, a "Send me a login link" `<button onclick="requestMagicLink()">`, a `<div id="login-status">` for the "Check your email" / error / dev-link states.

- [ ] **Step 3: Add the auth JS (near the other view logic)**

```js
async function fetchMe() {
  try {
    const r = await fetch('/v1/me', { credentials: 'same-origin' });
    currentUser = r.ok ? (await r.json()).user : null;
  } catch { currentUser = null; }
  renderAuthNav();
}
function renderAuthNav() {
  // Toggle a nav element: show currentUser.email + Log out when logged in, else a Log in link.
  const el = document.getElementById('auth-nav');
  if (!el) return;
  el.innerHTML = currentUser
    ? `<span class="auth-email">${currentUser.email}</span><a href="#" onclick="logout();return false">Log out</a>`
    : `<a href="#/login">Log in</a>`;
}
async function requestMagicLink() {
  const email = document.getElementById('login-email').value.trim();
  const status = document.getElementById('login-status');
  const r = await fetch('/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify({ email }),
  });
  if (r.status === 400) { status.textContent = 'Please enter a valid email.'; return; }
  const j = await r.json().catch(() => ({}));
  status.innerHTML = j.dev_link
    ? `Dev mode — <a href="${j.dev_link}">open your login link</a>`
    : 'Check your email for a login link.';
}
async function logout() {
  await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
  currentUser = null; renderAuthNav(); location.hash = '#/';
}
```
In the `DOMContentLoaded` handler (where `updateStats()` is called), call `await fetchMe();` before the initial `navigateTo(...)` so gating is correct on first paint.

- [ ] **Step 4: Update the account page for real identity**

- In the Credentials card, above the API-key field, show `currentUser.email` (from `fetchMe`).
- Change `generateWagmiPhotosKey()` to POST to `/v1/keys/generate` with `credentials: 'same-origin'`; on `401`, set `location.hash = '#/login'`.
- After generating (or on account view show), call a new `loadKeys()` that GETs `/v1/keys` and renders the list (label + created_at). Wire `'#/account'`'s `onShow` to also call `loadKeys`.

- [ ] **Step 5: Manual check (served locally)**

Run the app via the `running-locally` skill (`wrangler dev --local`). Confirm: visiting `#/playground` while logged out redirects to `#/login`; submitting an email shows the dev link (console + on-page); opening the link lands on `#/playground` logged in; `#/account` shows the email and can generate + list a key; Log out returns to `#/` and re-gates.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(auth): SPA login view, route gating, account identity + key list"
```

---

### Task 10: End-to-end verification + running-locally skill update

**Files:**
- Modify: `.claude/skills/running-locally/SKILL.md`

- [ ] **Step 1: Full offline suite**

Run (from `projects/worker`): `npx vitest run`
Expected: all suites PASS.

- [ ] **Step 2: Local end-to-end magic-link flow**

With `wrangler dev --local` running (no `RESEND_API_KEY`), from another shell:
```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"me@example.com"}'
```
Expected: `{"status":"sent","dev_link":"http://127.0.0.1:8787/v1/auth/verify?token=..."}`. Open the `dev_link` in a browser; confirm it 302s to `#/playground` and `GET /v1/me` (same browser) returns the user. Confirm `GET /v1/library` returns `401` when `MASTER_API_KEY` is set and no cookie; returns images with the session cookie.

- [ ] **Step 3: Update the `running-locally` skill**

Add a short "Auth in local dev" note to `.claude/skills/running-locally/SKILL.md`: magic links are logged to the Worker console and returned as `dev_link` from `/v1/auth/login`; the playground/library/account now require a dev login; the API lane stays open when `MASTER_API_KEY` is unset.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/running-locally/SKILL.md
git commit -m "docs(auth): local dev magic-link flow in running-locally skill"
```

---

## Self-Review

**Spec coverage:**
- Public/gated boundary → Task 7 (gating) + Task 9 (SPA `GATED` set). ✓
- Magic-link flow (login/verify/me/logout) → Task 6 + Task 7. ✓
- Two auth lanes (cookie + owned key + master + dev-open) → Task 4. ✓
- Data model migration `0004` → Task 1; stores → Task 2. ✓
- Server-side D1 sessions + HttpOnly cookie → Tasks 2–4. ✓
- Resend + dev fallback → Task 5; config → Task 8. ✓
- Anonymous key minting removed / keys owned → Task 2 (schema/store) + Task 7 (keygen session-gated). ✓
- Rate-limit login per email + IP, no enumeration → Task 6. ✓
- Local dev (console/dev_link link) → Tasks 5, 6, 9, 10. ✓
- Testing coverage → each backend task ships tests; frontend is manually verified (consistent with the existing test-free SPA). ✓

**Placeholder scan:** No "TBD/handle appropriately"; every code step has concrete code. Frontend Steps 2/4 describe DOM edits against the existing 4k-line file with concrete function bodies and exact endpoints (full markup for the big file is intentionally described rather than pasted, matching how the library-page plan handled the SPA). ✓

**Type consistency:** `getKeyOwner`/`addKey(hash, userId, label)`/`listByUser`, `resolveSession`/`resolveApiPrincipal` return `{ userId }`, `upsertByEmail(id, email)`, `sessions.resolve → { user_id }`, `loginTokens.consume → { email }` — used consistently across Tasks 2, 4, 6, 7. `handleKeygen(request, s, genKey, userId)` matches its Task 7 call site. ✓

## Notes / follow-ups (from spec)

- Billing/plan entitlement enforcement, social OAuth, server-side telemetry, "sign out everywhere", teams, and server-side BYOK storage are explicitly out of scope.
- At deploy: apply migration `0004` to remote D1 before deploying the Worker; `wrangler secret put RESEND_API_KEY`; verify the `wagmi.photos` sending domain in Resend; set `EMAIL_FROM`.
