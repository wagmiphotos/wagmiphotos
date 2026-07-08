# BYOK Self-Serve Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any signed-in user can store their own OpenAI or GMI Cloud API key (encrypted), have the worker generate a fresh image in-request whenever a result would be `approximate`/`pending`, capped per month, with an estimated spend meter — generated images join the shared library.

**Architecture:** The existing `handleGenerate` flow is unchanged through embed → shard query → floor check; a new `tryByokGenerate` orchestrator runs on the below-floor branches (denylist + OpenAI moderation fail-closed → atomic quota reserve → provider call → R2 original + D1 asset row + Vectorize upsert → `result:"generated"`). Keys live AES-256-GCM-encrypted in a new `byok_keys` table; usage in `byok_usage`. Key management is session-cookie-only (`PUT/PATCH/DELETE /v1/byok`), surfaced through `/v1/me` and a new account card.

**Tech Stack:** Cloudflare Workers (TypeScript, no framework), D1, Vectorize, R2, `crypto.subtle`, vitest, vanilla-JS SPA in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-07-09-byok-self-serve-generation-design.md`

## Global Constraints

- All work under `projects/worker` unless a path says otherwise. Run tests with `cd projects/worker && npx vitest run` and types with `cd projects/worker && npx tsc --noEmit`. The pre-existing suite (189 tests) must stay green after every task.
- `contract.json` (repo root) is the single source for cross-language constants. New constants: `byok_providers` (`openai → gpt-image-1 @ 0.04`, `gmicloud → gpt-image-2-generate @ 0.055`) and `denylist_terms`. Both language suites pin them (`projects/worker/test/contract.test.ts`, `projects/common/tests/test_contract.py`).
- The public generation API gains NO new request parameters and NO model picker. `generate_on_miss` (existing) is the per-request BYOK kill switch.
- Guardrails are fail-closed: no provider call without a passed denylist + moderation check. A moderation outage skips generation (falls back to today's behavior); it never generates unmoderated.
- Entitlement is untouched: bearer-key calls still 402 without an active plan (`src/index.ts:152-156`); BYOK never substitutes for the subscription.
- The provider key is decrypted only inside the generation path; no endpoint or log ever emits it (only `key_last4`).
- After quota reserve, any failure refunds the counter; after provider spend, indexing errors must NOT fail the request (log and continue).
- Python venv for the parity test: `.venv/bin/python` at repo root.
- Commit style: `feat(byok): …` / `test(byok): …`, matching recent history.

---

### Task 1: Contract constants + shared denylist (TS + Python parity)

**Files:**
- Modify: `contract.json` (repo root)
- Create: `projects/worker/src/denylist.ts`
- Create: `projects/worker/test/denylist.test.ts`
- Modify: `projects/worker/test/contract.test.ts`
- Modify: `projects/common/tests/test_contract.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `deniedTerm(prompt: string): string | null` from `src/denylist.ts`; `contract.byok_providers[provider] = { model: string, price_per_image_usd: number }`; `contract.denylist_terms: string[]`. Later tasks import both.

- [ ] **Step 1: Add the constants to `contract.json`**

Add these two top-level keys (keep existing keys untouched). The 28 denylist terms are copied verbatim from `projects/common/src/wagmiphotos/common/config.py` `denylist_terms` (split on commas):

```json
  "byok_providers": {
    "openai":   { "model": "gpt-image-1",          "price_per_image_usd": 0.04 },
    "gmicloud": { "model": "gpt-image-2-generate", "price_per_image_usd": 0.055 }
  },
  "denylist_terms": [
    "disney", "mickey mouse", "minnie mouse", "pikachu", "pokemon", "mario",
    "luigi", "nintendo", "marvel", "spider-man", "iron man", "batman",
    "superman", "star wars", "darth vader", "coca-cola", "pepsi", "nike",
    "adidas", "gucci", "prada", "louis vuitton", "chanel", "rolex",
    "hello kitty", "harry potter", "sonic the hedgehog", "minecraft", "fortnite"
  ]
```

Also extend the `_comment` sentence: `"byok_providers pins the fixed model + price estimate per BYOK provider; denylist_terms is the shared prompt denylist (worker + backfill)."`

- [ ] **Step 2: Write the failing TS tests**

`projects/worker/test/denylist.test.ts`:

```ts
import { it, expect } from "vitest";
import { deniedTerm } from "../src/denylist";

it("matches a denied term case-insensitively", () => {
  expect(deniedTerm("A cute Pikachu on a beach")).toBe("pikachu");
});

it("is word-bounded: apple-like substrings do not trip", () => {
  // "mario" must not match inside "marionette"
  expect(deniedTerm("a marionette puppet on strings")).toBeNull();
});

it("matches multi-word and hyphenated terms", () => {
  expect(deniedTerm("spider-man swinging through the city")).toBe("spider-man");
  expect(deniedTerm("STAR WARS style spaceship")).toBe("star wars");
});

it("returns null for clean prompts", () => {
  expect(deniedTerm("a red fox in the snow")).toBeNull();
});
```

Append to `projects/worker/test/contract.test.ts`:

```ts
it("byok provider pins: fixed model + price estimate per provider", () => {
  expect(contract.byok_providers.openai.model).toBe("gpt-image-1");
  expect(contract.byok_providers.gmicloud.model).toBe("gpt-image-2-generate");
  expect(contract.byok_providers.openai.price_per_image_usd).toBeGreaterThan(0);
  expect(contract.byok_providers.gmicloud.price_per_image_usd).toBeGreaterThan(0);
});

it("denylist_terms is a non-empty lowercase list", () => {
  expect(contract.denylist_terms.length).toBeGreaterThan(20);
  for (const t of contract.denylist_terms) expect(t).toBe(t.toLowerCase().trim());
});
```

(Use the existing `contract` import at the top of `contract.test.ts` — it already imports the JSON.)

- [ ] **Step 3: Run the TS tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/denylist.test.ts test/contract.test.ts`
Expected: FAIL — `Cannot find module '../src/denylist'` (and, before Step 1 is saved, missing `byok_providers`).

- [ ] **Step 4: Implement `src/denylist.ts`**

```ts
import contract from "../../../contract.json";

// Word-bounded, case-insensitive prompt denylist — same semantics as the
// Python Denylist in wagmiphotos.common.denylist; terms live in contract.json
// so both sides share one list. Trademark/IP guardrail, not a safety filter.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TERMS: string[] = (contract as any).denylist_terms;
const PATTERN = new RegExp("\\b(" + TERMS.map(escapeRe).join("|") + ")\\b", "i");

export function deniedTerm(prompt: string): string | null {
  const m = PATTERN.exec(prompt ?? "");
  return m ? m[0].toLowerCase() : null;
}
```

- [ ] **Step 5: Run TS tests to verify they pass**

Run: `cd projects/worker && npx vitest run test/denylist.test.ts test/contract.test.ts`
Expected: PASS (all, including pre-existing contract pins).

- [ ] **Step 6: Add the Python parity test**

Append to `projects/common/tests/test_contract.py` (follow the file's existing contract-loading helper — it already opens the repo-root `contract.json`):

```python
def test_denylist_terms_match_contract(contract):
    from wagmiphotos.common.config import Settings
    config_terms = [t.strip() for t in Settings().denylist_terms.split(",") if t.strip()]
    assert config_terms == contract["denylist_terms"]


def test_byok_gmicloud_price_matches_image_price(contract):
    from wagmiphotos.common.config import Settings
    assert contract["byok_providers"]["gmicloud"]["price_per_image_usd"] == Settings().image_price_usd
    assert contract["byok_providers"]["gmicloud"]["model"] == "gpt-image-2-generate"
```

If `test_contract.py` loads the contract without a pytest fixture named `contract`, match its existing loading pattern instead of the fixture argument.

- [ ] **Step 7: Run the Python tests**

Run: `cd projects/common && ../../.venv/bin/python -m pytest tests/test_contract.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add contract.json projects/worker/src/denylist.ts projects/worker/test/denylist.test.ts projects/worker/test/contract.test.ts projects/common/tests/test_contract.py
git commit -m "feat(byok): contract-pinned provider models/prices + shared denylist"
```

---

### Task 2: Migration 0013 + ByokStore (D1) + Services wiring

**Files:**
- Create: `projects/worker/migrations/0013_byok.sql`
- Modify: `projects/worker/src/types.ts` (add `ByokRow`, `ByokUsage`, `ByokStore`; add `byok` to `Services`)
- Modify: `projects/worker/src/d1.ts` (implement the store)
- Modify: `projects/worker/src/index.ts:17-39` (`buildServices` destructures + returns `byok`)
- Modify: `projects/worker/test/fakes.ts` (in-memory byok fake)
- Test: `projects/worker/test/byok-d1.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (in `src/types.ts`, used by every later task):

```ts
export interface ByokRow {
  user_id: string; provider: "openai" | "gmicloud"; key_ciphertext: string; key_last4: string;
  enabled: number; monthly_cap: number; last_error: string | null; created_at: string; updated_at: string;
}
export interface ByokUsage { count: number; est_spend_usd: number; }
export interface ByokStore {
  get(userId: string): Promise<ByokRow | null>;
  put(i: { userId: string; provider: string; keyCiphertext: string; keyLast4: string; monthlyCap: number; enabled: boolean }): Promise<void>;
  patch(userId: string, f: { enabled?: boolean; monthlyCap?: number }): Promise<void>;
  delete(userId: string): Promise<void>;
  /** Auth failure at the provider: flip enabled off and record why. */
  disable(userId: string, err: string): Promise<void>;
  getUsage(userId: string, month: string): Promise<ByokUsage>;
  /** Atomically take one unit of quota; false when the cap is already spent. */
  reserve(userId: string, month: string, cap: number): Promise<boolean>;
  refund(userId: string, month: string): Promise<void>;
  addSpend(userId: string, month: string, usd: number): Promise<void>;
}
```

`Services` gains `byok: ByokStore`.

- [ ] **Step 1: Write the migration**

`projects/worker/migrations/0013_byok.sql`:

```sql
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
```

- [ ] **Step 2: Write the failing store tests**

`projects/worker/test/byok-d1.test.ts` (same `fakeDb` harness style as `test/d1.test.ts` — copy its `fakeDb` helper into this file):

```ts
import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";

function fakeDb(firstResult: any = null, allResults: any[] = []) {
  const calls: { sql: string; args: any[] }[] = [];
  const db: any = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as any[],
        bind(...args: any[]) { this._args = args; return this; },
        async first() { calls.push({ sql, args: this._args }); return firstResult; },
        async run() { calls.push({ sql, args: this._args }); return { success: true }; },
        async all() { calls.push({ sql, args: this._args }); return { results: allResults }; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

it("put upserts by user and clears last_error", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.put({ userId: "u1", provider: "openai", keyCiphertext: "ct", keyLast4: "ab12", monthlyCap: 50, enabled: true });
  expect(calls[0].sql).toContain("INSERT INTO byok_keys");
  expect(calls[0].sql).toContain("ON CONFLICT(user_id)");
  expect(calls[0].sql).toContain("last_error = NULL");
  expect(calls[0].args).toEqual(["u1", "openai", "ct", "ab12", 1, 50]);
});

it("reserve upserts the month row then increments only under the cap", async () => {
  const { db, calls } = fakeDb({ count: 1 });
  const { byok } = makeD1Stores(db);
  const ok = await byok.reserve("u1", "2026-07", 50);
  expect(ok).toBe(true);
  expect(calls[0].sql).toContain("INSERT OR IGNORE INTO byok_usage");
  expect(calls[1].sql).toContain("count = count + 1");
  expect(calls[1].sql).toContain("count < ?");
  expect(calls[1].sql).toContain("RETURNING count");
  expect(calls[1].args).toEqual(["u1", "2026-07", 50]);
});

it("reserve returns false when the guarded update matches no row (cap spent)", async () => {
  const { db } = fakeDb(null);
  const { byok } = makeD1Stores(db);
  expect(await byok.reserve("u1", "2026-07", 50)).toBe(false);
});

it("refund decrements but never below zero", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.refund("u1", "2026-07");
  expect(calls[0].sql).toContain("MAX(count - 1, 0)");
});

it("disable flips enabled off and records the error", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.disable("u1", "provider_auth_failed");
  expect(calls[0].sql).toContain("enabled = 0");
  expect(calls[0].args).toEqual(["provider_auth_failed", "u1"]);
});

it("getUsage defaults to zeros when no row", async () => {
  const { db } = fakeDb(null);
  const { byok } = makeD1Stores(db);
  expect(await byok.getUsage("u1", "2026-07")).toEqual({ count: 0, est_spend_usd: 0 });
});

it("patch updates only the provided fields", async () => {
  const { db, calls } = fakeDb();
  const { byok } = makeD1Stores(db);
  await byok.patch("u1", { monthlyCap: 100 });
  expect(calls[0].sql).toContain("monthly_cap = ?");
  expect(calls[0].sql).not.toContain("enabled = ?");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/byok-d1.test.ts`
Expected: FAIL — `byok` is not returned by `makeD1Stores`.

- [ ] **Step 4: Implement**

In `src/types.ts`: add the `ByokRow` / `ByokUsage` / `ByokStore` interfaces from the Interfaces block above, and add `byok: ByokStore;` to `Services`.

In `src/d1.ts`: extend the return type of `makeD1Stores` with `byok: ByokStore` and add before the final `return`:

```ts
  const byok: ByokStore = {
    async get(userId) {
      const row = await db.prepare(
        "SELECT user_id, provider, key_ciphertext, key_last4, enabled, monthly_cap, last_error, created_at, updated_at FROM byok_keys WHERE user_id = ?"
      ).bind(userId).first<ByokRow>();
      return row ?? null;
    },
    async put({ userId, provider, keyCiphertext, keyLast4, monthlyCap, enabled }) {
      await db.prepare(
        `INSERT INTO byok_keys (user_id, provider, key_ciphertext, key_last4, enabled, monthly_cap)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           provider = excluded.provider, key_ciphertext = excluded.key_ciphertext,
           key_last4 = excluded.key_last4, enabled = excluded.enabled,
           monthly_cap = excluded.monthly_cap, last_error = NULL, updated_at = datetime('now')`
      ).bind(userId, provider, keyCiphertext, keyLast4, enabled ? 1 : 0, monthlyCap).run();
    },
    async patch(userId, f) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const args: unknown[] = [];
      if (f.enabled != null) { sets.push("enabled = ?"); args.push(f.enabled ? 1 : 0); }
      if (f.monthlyCap != null) { sets.push("monthly_cap = ?"); args.push(f.monthlyCap); }
      await db.prepare(`UPDATE byok_keys SET ${sets.join(", ")} WHERE user_id = ?`).bind(...args, userId).run();
    },
    async delete(userId) {
      await db.prepare("DELETE FROM byok_keys WHERE user_id = ?").bind(userId).run();
    },
    async disable(userId, err) {
      await db.prepare(
        "UPDATE byok_keys SET enabled = 0, last_error = ?, updated_at = datetime('now') WHERE user_id = ?"
      ).bind(err, userId).run();
    },
    async getUsage(userId, month) {
      const row = await db.prepare(
        "SELECT count, est_spend_usd FROM byok_usage WHERE user_id = ? AND month = ?"
      ).bind(userId, month).first<ByokUsage>();
      return row ?? { count: 0, est_spend_usd: 0 };
    },
    async reserve(userId, month, cap) {
      await db.prepare("INSERT OR IGNORE INTO byok_usage (user_id, month) VALUES (?, ?)").bind(userId, month).run();
      // Single guarded UPDATE = the atomic cap check; two concurrent requests
      // cannot both pass a spent cap.
      const row = await db.prepare(
        "UPDATE byok_usage SET count = count + 1 WHERE user_id = ? AND month = ? AND count < ? RETURNING count"
      ).bind(userId, month, cap).first();
      return !!row;
    },
    async refund(userId, month) {
      await db.prepare(
        "UPDATE byok_usage SET count = MAX(count - 1, 0) WHERE user_id = ? AND month = ?"
      ).bind(userId, month).run();
    },
    async addSpend(userId, month, usd) {
      await db.prepare(
        "UPDATE byok_usage SET est_spend_usd = est_spend_usd + ? WHERE user_id = ? AND month = ?"
      ).bind(usd, userId, month).run();
    },
  };
```

Add `ByokRow`, `ByokStore`, `ByokUsage` to the `import type` list at the top of `d1.ts`, and `byok` to the returned object.

In `src/index.ts` `buildServices`: change the destructure to include `byok` and add it to the returned `Services` object.

In `test/fakes.ts`: add to the `base` object (and import `ByokRow` in the types import):

```ts
    byok: {
      get: async (u) => byokRows.get(u) ?? null,
      put: async (i) => { byokRows.set(i.userId, { user_id: i.userId, provider: i.provider as ByokRow["provider"], key_ciphertext: i.keyCiphertext, key_last4: i.keyLast4, enabled: i.enabled ? 1 : 0, monthly_cap: i.monthlyCap, last_error: null, created_at: "x", updated_at: "x" }); },
      patch: async (u, f) => { const r = byokRows.get(u); if (!r) return; if (f.enabled != null) r.enabled = f.enabled ? 1 : 0; if (f.monthlyCap != null) r.monthly_cap = f.monthlyCap; },
      delete: async (u) => { byokRows.delete(u); },
      disable: async (u, err) => { const r = byokRows.get(u); if (r) { r.enabled = 0; r.last_error = err; } },
      getUsage: async (u, m) => ({ ...(byokUsage.get(`${u}:${m}`) ?? { count: 0, est_spend_usd: 0 }) }),
      reserve: async (u, m, cap) => { const k = `${u}:${m}`; const cur = byokUsage.get(k) ?? { count: 0, est_spend_usd: 0 }; if (cur.count >= cap) return false; cur.count += 1; byokUsage.set(k, cur); return true; },
      refund: async (u, m) => { const cur = byokUsage.get(`${u}:${m}`); if (cur) cur.count = Math.max(0, cur.count - 1); },
      addSpend: async (u, m, usd) => { const k = `${u}:${m}`; const cur = byokUsage.get(k) ?? { count: 0, est_spend_usd: 0 }; cur.est_spend_usd += usd; byokUsage.set(k, cur); },
    },
```

with these declarations next to the other maps at the top of `fakeServices`:

```ts
  const byokRows = new Map<string, ByokRow>();
  const byokUsage = new Map<string, { count: number; est_spend_usd: number }>();
```

and these exposures next to the other `_` internals:

```ts
  (base as any)._byokRows = byokRows;
  (base as any)._byokUsage = byokUsage;
```

- [ ] **Step 5: Run tests + types**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS (old + new), tsc clean.

- [ ] **Step 6: Apply the migration locally (sanity)**

Run: `cd projects/worker && npx wrangler d1 migrations apply wagmiphotos --local`
Expected: `0013_byok.sql` applied without error.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/migrations/0013_byok.sql projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/src/index.ts projects/worker/test/fakes.ts projects/worker/test/byok-d1.test.ts
git commit -m "feat(byok): migration 0013 + ByokStore (keys, atomic monthly quota)"
```

---

### Task 3: AES-256-GCM secret crypto

**Files:**
- Create: `projects/worker/src/crypto.ts`
- Test: `projects/worker/test/crypto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encryptSecret(plain: string, kekB64: string): Promise<string>` and `decryptSecret(stored: string, kekB64: string): Promise<string>` (throws on tamper/wrong key). `stored` format: `base64(iv[12] || ciphertext)`.

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/crypto.test.ts`:

```ts
import { it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../src/crypto";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const OTHER_KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

it("roundtrips a secret", async () => {
  const ct = await encryptSecret("sk-test-1234567890", KEK);
  expect(await decryptSecret(ct, KEK)).toBe("sk-test-1234567890");
});

it("produces a fresh IV per encryption (no deterministic ciphertext)", async () => {
  const a = await encryptSecret("same-secret", KEK);
  const b = await encryptSecret("same-secret", KEK);
  expect(a).not.toBe(b);
});

it("rejects tampered ciphertext", async () => {
  const ct = await encryptSecret("sk-test", KEK);
  const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  const tampered = btoa(String.fromCharCode(...bytes));
  await expect(decryptSecret(tampered, KEK)).rejects.toThrow();
});

it("rejects the wrong KEK", async () => {
  const ct = await encryptSecret("sk-test", KEK);
  await expect(decryptSecret(ct, OTHER_KEK)).rejects.toThrow();
});

it("rejects a KEK that is not 32 bytes", async () => {
  await expect(encryptSecret("sk-test", btoa("short"))).rejects.toThrow(/32 bytes/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/crypto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/crypto.ts`**

```ts
// Reversible at-rest encryption for user-supplied provider keys — the ONE
// secret we must replay to a third party, so hashing (auth.ts) can't work.
// AES-256-GCM under the BYOK_KEK worker secret; stored = base64(iv || ct).
const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));

async function importKek(kekB64: string): Promise<CryptoKey> {
  const raw = b64decode(kekB64);
  if (raw.length !== 32) throw new Error("BYOK_KEK must be 32 bytes of base64");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, kekB64: string): Promise<string> {
  const key = await importKek(kekB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64encode(out);
}

export async function decryptSecret(stored: string, kekB64: string): Promise<string> {
  const key = await importKek(kekB64);
  const buf = b64decode(stored);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npx vitest run test/crypto.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/crypto.ts projects/worker/test/crypto.test.ts
git commit -m "feat(byok): AES-256-GCM secret storage primitive"
```

---

### Task 4: Moderation client

**Files:**
- Create: `projects/worker/src/moderation.ts`
- Test: `projects/worker/test/moderation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `moderationFlagged(text: string, apiKey: string, fetchFn?: typeof fetch): Promise<string | null>` — resolves to the first flagged category name, `null` when clean, and **throws** on any HTTP/network failure (the caller decides fail-closed behavior). Mirrors `wagmiphotos.common.moderation.OpenAIModerator`.

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/moderation.test.ts`:

```ts
import { it, expect } from "vitest";
import { moderationFlagged, MODERATIONS_URL } from "../src/moderation";

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

it("returns null when not flagged", async () => {
  const fetchFn = (async (url: any, init: any) => {
    expect(String(url)).toBe(MODERATIONS_URL);
    expect(init.headers.Authorization).toBe("Bearer sk-mod");
    expect(JSON.parse(init.body).model).toBe("omni-moderation-latest");
    return okJson({ results: [{ flagged: false, categories: {} }] });
  }) as unknown as typeof fetch;
  expect(await moderationFlagged("a red fox", "sk-mod", fetchFn)).toBeNull();
});

it("returns the first flagged category", async () => {
  const fetchFn = (async () =>
    okJson({ results: [{ flagged: true, categories: { violence: false, sexual: true } }] })
  ) as unknown as typeof fetch;
  expect(await moderationFlagged("bad", "sk-mod", fetchFn)).toBe("sexual");
});

it("returns 'flagged' when flagged with no category detail", async () => {
  const fetchFn = (async () => okJson({ results: [{ flagged: true, categories: {} }] })) as unknown as typeof fetch;
  expect(await moderationFlagged("bad", "sk-mod", fetchFn)).toBe("flagged");
});

it("throws on non-2xx (caller fails closed)", async () => {
  const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await expect(moderationFlagged("x", "sk-mod", fetchFn)).rejects.toThrow(/moderation 500/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/moderation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/moderation.ts`**

```ts
// OpenAI Moderations (free endpoint) — same guardrail the backfill runs
// (wagmiphotos.common.moderation). Throws on transport/HTTP errors so the
// caller can fail closed: no moderation verdict, no generation.
export const MODERATIONS_URL = "https://api.openai.com/v1/moderations";

export async function moderationFlagged(
  text: string, apiKey: string, fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const res = await fetchFn(MODERATIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "omni-moderation-latest" }),
  });
  if (!res.ok) throw new Error(`moderation ${res.status}`);
  const data: any = await res.json();
  const r = data?.results?.[0];
  if (!r?.flagged) return null;
  for (const [name, hit] of Object.entries(r.categories ?? {})) if (hit) return name;
  return "flagged";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npx vitest run test/moderation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/moderation.ts projects/worker/test/moderation.test.ts
git commit -m "feat(byok): OpenAI moderation client (fail-closed contract)"
```

---

### Task 5: Image providers (OpenAI + GMI Cloud)

**Files:**
- Create: `projects/worker/src/providers.ts`
- Test: `projects/worker/test/providers.test.ts`

**Interfaces:**
- Consumes: `contract.byok_providers` (Task 1).
- Produces:

```ts
export interface GeneratedImage { bytes: ArrayBuffer; mime: string; }
export class ProviderAuthError extends Error {}
export interface ImageProvider {
  generate(prompt: string, apiKey: string): Promise<GeneratedImage>;   // throws ProviderAuthError on 401/403
  validateKey(apiKey: string): Promise<boolean>;
}
export function providerFor(name: string, fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void>): ImageProvider;
```

API facts (verified against `genblaze_gmicloud` 0.3.1 and the OpenAI Images API):
- OpenAI: `POST https://api.openai.com/v1/images/generations` `{ model: "gpt-image-1", prompt, n: 1, size: "1024x1024" }` → `data[0].b64_json` (PNG). Validate: `GET https://api.openai.com/v1/models` → 200.
- GMI queue: base `https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey`, Bearer auth. Submit `POST {base}/requests` `{ model: "gpt-image-2-generate", payload: { prompt, size: "1024x1024" } }` → `{ request_id }` (or `{ id }`). Poll `GET {base}/requests/{id}` → `{ status, outcome }`; terminal statuses `success|failed|cancelled`; image URL at `outcome.media_urls[0].url` (fallbacks: string entries, `outcome.image_url`, `outcome.url`). Validate: `GET {base}/requests` → 200.

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/providers.test.ts`:

```ts
import { it, expect } from "vitest";
import { providerFor, ProviderAuthError } from "../src/providers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

it("openai: posts gpt-image-1 and decodes b64_json", async () => {
  const calls: any[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return okJson({ data: [{ b64_json: btoa("\x89PNG") }] });
  }) as unknown as typeof fetch;
  const img = await providerFor("openai", fetchFn).generate("a red fox", "sk-user");
  expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
  expect(calls[0].body).toEqual({ model: "gpt-image-1", prompt: "a red fox", n: 1, size: "1024x1024" });
  expect(img.mime).toBe("image/png");
  expect(new Uint8Array(img.bytes)).toEqual(new Uint8Array(PNG));
});

it("openai: 401 throws ProviderAuthError", async () => {
  const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await expect(providerFor("openai", fetchFn).generate("x", "bad")).rejects.toBeInstanceOf(ProviderAuthError);
});

it("openai: validateKey pings /models", async () => {
  const fetchFn = (async (url: any) => {
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    return okJson({ data: [] });
  }) as unknown as typeof fetch;
  expect(await providerFor("openai", fetchFn).validateKey("sk-user")).toBe(true);
});

it("gmicloud: submits to the request queue, polls to success, fetches the image", async () => {
  let polls = 0;
  const fetchFn = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/requests") && init?.method === "POST") {
      expect(JSON.parse(init.body)).toEqual({ model: "gpt-image-2-generate", payload: { prompt: "a red fox", size: "1024x1024" } });
      return okJson({ request_id: "req-1" });
    }
    if (u.endsWith("/requests/req-1")) {
      polls += 1;
      return polls < 2
        ? okJson({ status: "running" })
        : okJson({ status: "success", outcome: { media_urls: [{ url: "https://cdn.gmi/img.png" }] } });
    }
    if (u === "https://cdn.gmi/img.png") return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn, async () => {}); // no-op sleep
  const img = await gmi.generate("a red fox", "gmi-key");
  expect(img.mime).toBe("image/png");
  expect(polls).toBe(2);
});

it("gmicloud: failed status throws a plain error (not auth)", async () => {
  const fetchFn = (async (url: any, init?: any) => {
    if (init?.method === "POST") return okJson({ request_id: "req-1" });
    return okJson({ status: "failed", error: "boom" });
  }) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn, async () => {});
  await expect(gmi.generate("x", "k")).rejects.toThrow(/failed/);
});

it("unknown provider throws", () => {
  expect(() => providerFor("google")).toThrow(/unknown provider/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/providers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers.ts`**

```ts
import contract from "../../../contract.json";

// Direct HTTP adapters for the two BYOK providers. Models are pinned in
// contract.json (byok_providers) — the public API has no model parameter.
export interface GeneratedImage { bytes: ArrayBuffer; mime: string; }
export class ProviderAuthError extends Error {}
export interface ImageProvider {
  generate(prompt: string, apiKey: string): Promise<GeneratedImage>;
  validateKey(apiKey: string): Promise<boolean>;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PINNED: Record<string, { model: string; price_per_image_usd: number }> = (contract as any).byok_providers;

const OPENAI_API = "https://api.openai.com/v1";

function makeOpenAiProvider(fetchFn: typeof fetch): ImageProvider {
  return {
    async generate(prompt, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: PINNED.openai.model, prompt, n: 1, size: "1024x1024" }),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai images ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data: any = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 !== "string") throw new Error("openai images: no b64_json in response");
      return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, mime: "image/png" };
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${OPENAI_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return res.ok;
    },
  };
}

// GMI Cloud's async request queue (same API genblaze_gmicloud wraps):
// submit -> poll until a terminal status -> download the image URL.
const GMI_QUEUE = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey";
const GMI_POLL_MS = 2500;
const GMI_DEADLINE_MS = 55_000;

function makeGmiProvider(fetchFn: typeof fetch, sleep: Sleep): ImageProvider {
  return {
    async generate(prompt, apiKey) {
      const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const submit = await fetchFn(`${GMI_QUEUE}/requests`, {
        method: "POST", headers,
        body: JSON.stringify({ model: PINNED.gmicloud.model, payload: { prompt, size: "1024x1024" } }),
      });
      if (submit.status === 401 || submit.status === 403) throw new ProviderAuthError(`gmicloud ${submit.status}`);
      if (!submit.ok) throw new Error(`gmicloud submit ${submit.status}: ${(await submit.text().catch(() => "")).slice(0, 300)}`);
      const sub: any = await submit.json();
      const id = sub?.request_id ?? sub?.id;
      if (!id) throw new Error("gmicloud submit: no request id");

      const deadline = Date.now() + GMI_DEADLINE_MS;
      while (Date.now() < deadline) {
        await sleep(GMI_POLL_MS);
        const poll = await fetchFn(`${GMI_QUEUE}/requests/${id}`, { headers });
        if (!poll.ok) throw new Error(`gmicloud poll ${poll.status}`);
        const detail: any = await poll.json();
        const status = String(detail?.status ?? "");
        if (status === "failed" || status === "cancelled") {
          throw new Error(`gmicloud generation ${status}: ${String(detail?.error ?? "")}`.slice(0, 300));
        }
        if (status === "success") {
          const raw = detail?.outcome?.media_urls;
          const first = Array.isArray(raw)
            ? (typeof raw[0] === "string" ? raw[0] : raw[0]?.url)
            : (detail?.outcome?.image_url ?? detail?.outcome?.url);
          if (!first) throw new Error("gmicloud: success but no image url");
          const img = await fetchFn(first);
          if (!img.ok) throw new Error(`gmicloud image fetch ${img.status}`);
          const mime = img.headers.get("Content-Type")?.split(";")[0] || "image/png";
          return { bytes: await img.arrayBuffer(), mime };
        }
      }
      throw new Error("gmicloud generation timed out");
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${GMI_QUEUE}/requests`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return res.ok;
    },
  };
}

export function providerFor(name: string, fetchFn: typeof fetch = fetch, sleep: Sleep = realSleep): ImageProvider {
  if (name === "openai") return makeOpenAiProvider(fetchFn);
  if (name === "gmicloud") return makeGmiProvider(fetchFn, sleep);
  throw new Error(`unknown provider ${name}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npx vitest run test/providers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/providers.ts projects/worker/test/providers.test.ts
git commit -m "feat(byok): OpenAI + GMI Cloud image provider adapters"
```

---

### Task 6: Vectorize upsert + asset insert

**Files:**
- Modify: `projects/worker/src/types.ts` (`VectorizeStore.upsert`, `AssetStore.insertGenerated`)
- Modify: `projects/worker/src/vectorize.ts`
- Modify: `projects/worker/src/d1.ts`
- Modify: `projects/worker/test/fakes.ts`
- Test: `projects/worker/test/vectorize.test.ts`, `projects/worker/test/byok-d1.test.ts` (append)

**Interfaces:**
- Consumes: `shardFor` from `src/shard.ts` (exists).
- Produces:
  - `VectorizeStore.upsert(id: string, vector: number[]): Promise<void>` — routes to shard `fnv1a32(id) % bindings.length`.
  - `AssetStore.insertGenerated(a: { id: string; prompt: string; sourceUrl: string; mime: string; width: number | null; height: number | null; modelUsed: string; provider: string; priceUsd: number }): Promise<void>` — inserts `source='byok'`, `locally_cached=0`, legacy NOT-NULL `url` = `sourceUrl`.

- [ ] **Step 1: Write the failing tests**

Append to `projects/worker/test/vectorize.test.ts` (match its existing fake-binding style; if it builds bindings differently, reuse that helper):

```ts
it("upsert routes to the fnv1a32(id) % shards binding", async () => {
  const upserts: { shard: number; rows: any[] }[] = [];
  const mk = (shard: number): any => ({
    query: async () => ({ matches: [] }),
    upsert: async (rows: any[]) => { upserts.push({ shard, rows }); },
  });
  const store = makeVectorize([mk(0), mk(1), mk(2)]);
  // contract.json shard_fixtures pins "demo-3" -> shard 1
  await store.upsert("demo-3", [0.1, 0.2]);
  expect(upserts).toEqual([{ shard: 1, rows: [{ id: "demo-3", values: [0.1, 0.2] }] }]);
});
```

Append to `projects/worker/test/byok-d1.test.ts`:

```ts
it("insertGenerated writes a byok asset row satisfying legacy NOT NULLs", async () => {
  const { db, calls } = fakeDb();
  const { assets } = makeD1Stores(db);
  await assets.insertGenerated({
    id: "gen-1", prompt: "a red fox", sourceUrl: "https://byok.example/byok/gen-1/original.png",
    mime: "image/png", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai", priceUsd: 0.04,
  });
  expect(calls[0].sql).toContain("INSERT INTO assets");
  expect(calls[0].sql).toContain("'byok'");
  // legacy url column mirrors source_url until the rehost pipeline derives sizes
  expect(calls[0].args).toEqual(["gen-1", "a red fox", "gpt-image-1", 1024, 1024, "image/png",
    "https://byok.example/byok/gen-1/original.png", "https://byok.example/byok/gen-1/original.png", 0.04, "openai"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/vectorize.test.ts test/byok-d1.test.ts`
Expected: FAIL — `upsert` / `insertGenerated` do not exist.

- [ ] **Step 3: Implement**

`src/types.ts`:

```ts
export interface VectorizeStore {
  query(vector: number[], topK: number): Promise<Match[]>;
  /** Shard-routed write (fnv1a32(id) % shards) — BYOK in-request ingest. */
  upsert(id: string, vector: number[]): Promise<void>;
}
```

and add to `AssetStore`:

```ts
  /** Insert a BYOK-generated asset. source='byok'; the row serves from
   *  source_url until the demand-first rehost derives B2 sizes (0008). */
  insertGenerated(a: { id: string; prompt: string; sourceUrl: string; mime: string; width: number | null; height: number | null; modelUsed: string; provider: string; priceUsd: number }): Promise<void>;
```

`src/vectorize.ts` — add to the returned object (and `import { shardFor } from "./shard";`):

```ts
    async upsert(id, vector) {
      await bindings[shardFor(id, bindings.length)].upsert([{ id, values: vector }]);
    },
```

`src/d1.ts` — add to the `assets` store:

```ts
    async insertGenerated(a) {
      // url (legacy NOT NULL) mirrors source_url; assetUrls() ignores it for
      // non-locally_cached rows and serves source_url directly.
      await db.prepare(
        `INSERT INTO assets (id, prompt, source, model_used, width, height, mime, source_url, url, locally_cached, price_usd, provider)
         VALUES (?, ?, 'byok', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(a.id, a.prompt, a.modelUsed, a.width, a.height, a.mime, a.sourceUrl, a.sourceUrl, a.priceUsd, a.provider).run();
    },
```

`test/fakes.ts` — add to the `assets` fake:

```ts
      insertGenerated: async (a) => {
        assets.set(a.id, {
          id: a.id, prompt: a.prompt, source: "byok", source_id: null, model_used: a.modelUsed,
          width: a.width, height: a.height, mime: a.mime, source_url: a.sourceUrl, locally_cached: 0,
        });
      },
```

and to the `vectorize` fake:

```ts
    vectorize: {
      query: async () => matches,
      upsert: async (id: string, vector: number[]) => { upserted.push({ id, vector }); },
    },
```

with `const upserted: { id: string; vector: number[] }[] = [];` declared with the other arrays and `(base as any)._upserted = upserted;` exposed.

- [ ] **Step 4: Run tests + types**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/types.ts projects/worker/src/vectorize.ts projects/worker/src/d1.ts projects/worker/test/fakes.ts projects/worker/test/vectorize.test.ts projects/worker/test/byok-d1.test.ts
git commit -m "feat(byok): shard-routed vector upsert + byok asset insert"
```

---

### Task 7: `tryByokGenerate` orchestrator

**Files:**
- Create: `projects/worker/src/byok.ts`
- Test: `projects/worker/test/byok.test.ts`

**Interfaces:**
- Consumes: `ByokStore` (Task 2), `decryptSecret` (Task 3), `moderationFlagged` (Task 4), `providerFor`/`ProviderAuthError`/`ImageProvider` (Task 5), `insertGenerated`/`upsert` (Task 6), `deniedTerm` (Task 1), `contract.byok_providers`.
- Produces (used by Task 8 and Task 9):

```ts
export interface ByokBucket { put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; }
export interface ByokCfg {
  kek?: string;                 // env.BYOK_KEK
  moderationKey?: string;       // env.OPENAI_API_KEY (operator key; gmicloud users)
  bucket?: ByokBucket;          // env.BYOK_ORIGINALS
  publicUrlBase?: string;       // env.BYOK_PUBLIC_URL_BASE
  now: () => number;            // unix seconds
  fetchFn?: typeof fetch;       // test seam (moderation + default providers)
  providerFor?: (name: string) => ImageProvider;  // test seam
  uuid?: () => string;          // test seam
}
export type ByokOutcome =
  | { kind: "generated"; asset: AssetRow; used: number; cap: number; estSpendUsd: number }
  | { kind: "content_policy"; category: string }
  | { kind: "cap_reached" }
  | { kind: "provider_error" }
  | { kind: "skipped" };
export function monthKey(nowSec: number): string;  // 'YYYY-MM' UTC
export async function tryByokGenerate(i: { userId: string; prompt: string; vec: number[] }, s: Services, cfg: ByokCfg): Promise<ByokOutcome>;
```

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/byok.test.ts`:

```ts
import { it, expect } from "vitest";
import { tryByokGenerate, monthKey, type ByokCfg } from "../src/byok";
import { encryptSecret } from "../src/crypto";
import { ProviderAuthError, type ImageProvider } from "../src/providers";
import { fakeServices } from "./fakes";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const NOW = 1783468800; // 2026-07-08T00:00:00Z -> monthKey "2026-07"
const PNG = new Uint8Array([0x89, 0x50]).buffer;

const cleanModeration = (async () =>
  new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 })
) as unknown as typeof fetch;

function okProvider(): ImageProvider {
  return { generate: async () => ({ bytes: PNG, mime: "image/png" }), validateKey: async () => true };
}

async function seededServices(over: Partial<{ enabled: boolean; cap: number; provider: string }> = {}) {
  const s = fakeServices();
  await s.byok.put({
    userId: "u1", provider: over.provider ?? "openai",
    keyCiphertext: await encryptSecret("sk-user-key", KEK), keyLast4: "-key",
    monthlyCap: over.cap ?? 50, enabled: over.enabled ?? true,
  });
  return s;
}

function cfg(over: Partial<ByokCfg> = {}): ByokCfg {
  return {
    kek: KEK, moderationKey: "sk-operator", bucket: { put: async () => ({}) },
    publicUrlBase: "https://byok.example", now: () => NOW,
    fetchFn: cleanModeration, providerFor: () => okProvider(), uuid: () => "gen-1",
    ...over,
  };
}

it("monthKey is the UTC calendar month", () => {
  expect(monthKey(NOW)).toBe("2026-07");
});

it("happy path: moderates, reserves, generates, persists, indexes, accounts", async () => {
  const s = await seededServices();
  const puts: string[] = [];
  const out = await tryByokGenerate({ userId: "u1", prompt: "a red fox", vec: [0.1] }, s,
    cfg({ bucket: { put: async (key) => { puts.push(key); return {}; } } }));
  expect(out.kind).toBe("generated");
  if (out.kind !== "generated") return;
  expect(puts).toEqual(["byok/gen-1/original.png"]);
  expect(out.asset.source).toBe("byok");
  expect(out.asset.source_url).toBe("https://byok.example/byok/gen-1/original.png");
  expect(out.used).toBe(1);
  expect(out.cap).toBe(50);
  expect(out.estSpendUsd).toBeCloseTo(0.04);
  expect((s as any)._upserted).toEqual([{ id: "gen-1", vector: [0.1] }]);
});

it("skipped when no key row / disabled / cfg incomplete", async () => {
  const bare = fakeServices();
  expect((await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, bare, cfg())).kind).toBe("skipped");
  const off = await seededServices({ enabled: false });
  expect((await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, off, cfg())).kind).toBe("skipped");
  const s = await seededServices();
  expect((await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ kek: undefined }))).kind).toBe("skipped");
});

it("denylist term short-circuits before moderation and provider", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "pikachu at dawn", vec: [] }, s,
    cfg({ fetchFn: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch }));
  expect(out).toEqual({ kind: "content_policy", category: "denylist:pikachu" });
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("moderation flag -> content_policy, nothing reserved", async () => {
  const s = await seededServices();
  const flagged = (async () =>
    new Response(JSON.stringify({ results: [{ flagged: true, categories: { violence: true } }] }), { status: 200 })
  ) as unknown as typeof fetch;
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ fetchFn: flagged }));
  expect(out).toEqual({ kind: "content_policy", category: "violence" });
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("moderation outage -> provider_error (fail closed), nothing reserved", async () => {
  const s = await seededServices();
  const down = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ fetchFn: down }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("gmicloud user without an operator moderation key is skipped (never unmoderated)", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ moderationKey: undefined }));
  expect(out.kind).toBe("skipped");
});

it("cap reached -> cap_reached, no provider call", async () => {
  const s = await seededServices({ cap: 1 });
  await s.byok.reserve("u1", "2026-07", 1); // spend the month
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ providerFor: () => ({ generate: async () => { throw new Error("must not generate"); }, validateKey: async () => true }) }));
  expect(out.kind).toBe("cap_reached");
});

it("provider failure refunds the reservation", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ providerFor: () => ({ generate: async () => { throw new Error("boom"); }, validateKey: async () => true }) }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("provider 401 refunds, disables the key, and records last_error", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ providerFor: () => ({ generate: async () => { throw new ProviderAuthError("401"); }, validateKey: async () => true }) }));
  expect(out.kind).toBe("provider_error");
  const row = (s as any)._byokRows.get("u1");
  expect(row.enabled).toBe(0);
  expect(row.last_error).toBe("provider_auth_failed");
});

it("R2 put failure refunds", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ bucket: { put: async () => { throw new Error("r2 down"); } } }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("vector upsert failure does NOT fail the request (post-spend)", async () => {
  const s = await seededServices();
  (s.vectorize as any).upsert = async () => { throw new Error("vectorize offline"); };
  const out = await tryByokGenerate({ userId: "u1", prompt: "a red fox", vec: [0.1] }, s, cfg());
  expect(out.kind).toBe("generated");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/byok.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/byok.ts`**

```ts
import type { AssetRow, Services } from "./types";
import { decryptSecret } from "./crypto";
import { deniedTerm } from "./denylist";
import { moderationFlagged } from "./moderation";
import { providerFor as realProviderFor, ProviderAuthError, type ImageProvider } from "./providers";
import contract from "../../../contract.json";

export interface ByokBucket { put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; }
export interface ByokCfg {
  kek?: string;
  moderationKey?: string;
  bucket?: ByokBucket;
  publicUrlBase?: string;
  now: () => number;
  fetchFn?: typeof fetch;
  providerFor?: (name: string) => ImageProvider;
  uuid?: () => string;
}
export type ByokOutcome =
  | { kind: "generated"; asset: AssetRow; used: number; cap: number; estSpendUsd: number }
  | { kind: "content_policy"; category: string }
  | { kind: "cap_reached" }
  | { kind: "provider_error" }
  | { kind: "skipped" };

export function monthKey(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 7);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp" };

// The BYOK in-request generation path. Ordering is load-bearing:
// guardrails (fail-closed) -> atomic quota reserve -> provider -> durable
// persist (R2 + D1) -> best-effort index -> accounting. Any throw after the
// reserve refunds it; after provider spend, indexing errors never fail the
// request (the image is already durable and paid for).
export async function tryByokGenerate(
  i: { userId: string; prompt: string; vec: number[] }, s: Services, cfg: ByokCfg
): Promise<ByokOutcome> {
  if (!cfg.kek || !cfg.bucket || !cfg.publicUrlBase) return { kind: "skipped" };
  const row = await s.byok.get(i.userId);
  if (!row || !row.enabled) return { kind: "skipped" };
  const pinned = (contract as any).byok_providers[row.provider];
  if (!pinned) return { kind: "skipped" };

  const term = deniedTerm(i.prompt);
  if (term) return { kind: "content_policy", category: `denylist:${term}` };

  let apiKey: string;
  try { apiKey = await decryptSecret(row.key_ciphertext, cfg.kek); }
  catch (e) { console.error("byok decrypt failed", e); return { kind: "provider_error" }; }

  // openai users are moderated with their own key (the endpoint is free);
  // gmicloud users need the operator OPENAI_API_KEY. No key => never generate.
  const modKey = row.provider === "openai" ? apiKey : cfg.moderationKey;
  if (!modKey) return { kind: "skipped" };
  let category: string | null;
  try { category = await moderationFlagged(i.prompt, modKey, cfg.fetchFn ?? fetch); }
  catch (e) { console.error("byok moderation unavailable", e); return { kind: "provider_error" }; }
  if (category) return { kind: "content_policy", category };

  const month = monthKey(cfg.now());
  if (!(await s.byok.reserve(i.userId, month, row.monthly_cap))) return { kind: "cap_reached" };

  try {
    const provider = (cfg.providerFor ?? ((n: string) => realProviderFor(n, cfg.fetchFn ?? fetch)))(row.provider);
    const img = await provider.generate(i.prompt, apiKey);
    const id = (cfg.uuid ?? (() => crypto.randomUUID()))();
    const key = `byok/${id}/original.${EXT[img.mime] ?? "png"}`;
    await cfg.bucket.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    const sourceUrl = `${cfg.publicUrlBase.replace(/\/+$/, "")}/${key}`;
    await s.assets.insertGenerated({
      id, prompt: i.prompt, sourceUrl, mime: img.mime,
      width: 1024, height: 1024, // requested size; providers may letterbox but 1024x1024 is what we ask for
      modelUsed: pinned.model, provider: row.provider, priceUsd: pinned.price_per_image_usd,
    });
    try { await s.vectorize.upsert(id, i.vec); } catch (e) { console.error("byok vector upsert failed", e); }
    await s.byok.addSpend(i.userId, month, pinned.price_per_image_usd);
    const usage = await s.byok.getUsage(i.userId, month);
    const asset = await s.assets.getAsset(id);
    if (!asset) throw new Error("inserted byok asset not readable");
    return { kind: "generated", asset, used: usage.count, cap: row.monthly_cap, estSpendUsd: usage.est_spend_usd };
  } catch (e) {
    console.error("byok generation failed", e);
    try { await s.byok.refund(i.userId, month); } catch (re) { console.error("byok refund failed", re); }
    if (e instanceof ProviderAuthError) {
      try { await s.byok.disable(i.userId, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
    }
    return { kind: "provider_error" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/worker && npx vitest run test/byok.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/byok.ts projects/worker/test/byok.test.ts
git commit -m "feat(byok): in-request generation orchestrator (guardrails, quota, ingest)"
```

---

### Task 8: Wire BYOK into `handleGenerate`

**Files:**
- Modify: `projects/worker/src/handler.ts:18-90`
- Test: `projects/worker/test/handler.test.ts` (append)

**Interfaces:**
- Consumes: `tryByokGenerate`, `ByokCfg`, `ByokOutcome` (Task 7); everything already in `handleGenerate`.
- Produces: new signature — `handleGenerate(body: GenBody, s: Services, cfg: GenCfg, byok?: { userId: string; cfg: ByokCfg } | null)`. Existing 3-arg callers keep working (`byok` optional).
- Response contract:
  - Fresh generation: HTTP 200, `shared_cache.result = "generated"`, `similarity: 1`, `cost_saved_usd: 0`, `source: "byok"`, plus `shared_cache.byok = { used, cap, est_spend_usd }`.
  - Denylist/moderation flag: HTTP 400 `{ error: "content_policy", category }`.
  - Cap reached / provider failure: today's `approximate`/`pending` response, plus `shared_cache.byok = { status: "cap_reached" | "provider_error" }`.
  - BYOK fires only when the result would be approximate/pending AND `generate_on_miss` is true.

- [ ] **Step 1: Write the failing tests**

Append to `projects/worker/test/handler.test.ts` (reuse its existing `fakeServices`/cfg helpers; the `cfg` below means the file's existing `GenCfg` fixture with `floorSimMax: 0.87, floorSimMin: 0.75` semantics — adapt names to the file's local helpers):

```ts
import { encryptSecret } from "../src/crypto";
import type { ByokCfg } from "../src/byok";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const cleanModeration = (async () =>
  new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 })
) as unknown as typeof fetch;

async function byokCtx(s: any, over: Partial<ByokCfg> = {}) {
  await s.byok.put({
    userId: "u1", provider: "openai",
    keyCiphertext: await encryptSecret("sk-user", KEK), keyLast4: "user", monthlyCap: 50, enabled: true,
  });
  return {
    userId: "u1",
    cfg: {
      kek: KEK, moderationKey: "sk-op", bucket: { put: async () => ({}) },
      publicUrlBase: "https://byok.example", now: () => 1783468800, // 2026-07-08 UTC

      fetchFn: cleanModeration,
      providerFor: () => ({ generate: async () => ({ bytes: new Uint8Array([1]).buffer, mime: "image/png" }), validateKey: async () => true }),
      uuid: () => "gen-1",
      ...over,
    } as ByokCfg,
  };
}

it("below-floor + BYOK: returns result=generated with usage block and records built", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.5 });
  (s as any)._assets.set("a1", { id: "a1", prompt: "old", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, await byokCtx(s));
  const body: any = await res.json();
  expect(res.status).toBe(200);
  expect(body.shared_cache.result).toBe("generated");
  expect(body.shared_cache.source).toBe("byok");
  expect(body.shared_cache.byok).toEqual({ used: 1, cap: 50, est_spend_usd: 0.04 });
  expect(body.data[0].url).toBe("https://byok.example/byok/gen-1/original.png");
  const recorded = (s as any)._recorded;
  expect(recorded[recorded.length - 1]).toMatchObject({ assetId: "gen-1", built: true });
});

it("empty pool + BYOK: generates instead of 202 pending", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, await byokCtx(s));
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).shared_cache.result).toBe("generated");
});

it("hit is untouched by BYOK", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.99 });
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, await byokCtx(s));
  expect(((await res.json()) as any).shared_cache.result).toBe("hit");
});

it("generate_on_miss=false is the kill switch: no BYOK, normal approximate", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.5 });
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const res = await handleGenerate({ prompt: "a red fox", generate_on_miss: false }, s, cfg, await byokCtx(s));
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.byok).toBeUndefined();
});

it("content policy -> 400 with category", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "pikachu portrait" }, s, cfg, await byokCtx(s));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "content_policy", category: "denylist:pikachu" });
});

it("cap reached -> approximate fallback with byok status", async () => {
  const s = fakeServices();
  (s as any)._matches.push({ id: "a1", score: 0.5 });
  (s as any)._assets.set("a1", { id: "a1", prompt: "p", source: "pd12m", source_id: null, model_used: null, width: 1, height: 1, mime: "image/webp", source_url: "https://ext/x.webp", locally_cached: 0 });
  const ctx = await byokCtx(s);
  await s.byok.patch("u1", { monthlyCap: 1 });
  await s.byok.reserve("u1", "2026-07", 1);
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, ctx);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("approximate");
  expect(body.shared_cache.byok).toEqual({ status: "cap_reached" });
});

it("provider failure on empty pool -> 202 pending with byok status", async () => {
  const s = fakeServices();
  const ctx = await byokCtx(s, { providerFor: () => ({ generate: async () => { throw new Error("boom"); }, validateKey: async () => true }) });
  const res = await handleGenerate({ prompt: "a red fox" }, s, cfg, ctx);
  expect(res.status).toBe(202);
  const body: any = await res.json();
  expect(body.shared_cache.result).toBe("pending");
  expect(body.shared_cache.byok).toEqual({ status: "provider_error" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/handler.test.ts`
Expected: FAIL — 4th argument ignored / `generated` never returned.

- [ ] **Step 3: Implement in `src/handler.ts`**

Add imports:

```ts
import { tryByokGenerate, type ByokCfg, type ByokOutcome } from "./byok";
```

Change the signature:

```ts
export async function handleGenerate(
  body: GenBody, s: Services, cfg: GenCfg,
  byok?: { userId: string; cfg: ByokCfg } | null
): Promise<Response> {
```

Insert one helper above `handleGenerate` (after the existing consts):

```ts
// BYOK fires exactly where the response would be approximate/pending and the
// request did not opt out of generation. Returns null when BYOK didn't take
// over (skipped / fallback) so the caller continues with today's behavior;
// fallbackStatus carries cap_reached/provider_error into the fallback body.
async function runByok(
  byok: { userId: string; cfg: ByokCfg } | null | undefined,
  generateOnMiss: boolean, prompt: string, vec: number[], s: Services
): Promise<{ outcome: ByokOutcome | null; fallbackStatus: string | null }> {
  if (!byok || !generateOnMiss) return { outcome: null, fallbackStatus: null };
  const outcome = await tryByokGenerate({ userId: byok.userId, prompt, vec }, s, byok.cfg);
  if (outcome.kind === "generated" || outcome.kind === "content_policy") return { outcome, fallbackStatus: null };
  if (outcome.kind === "cap_reached" || outcome.kind === "provider_error") return { outcome: null, fallbackStatus: outcome.kind };
  return { outcome: null, fallbackStatus: null }; // skipped
}

function generatedResponse(outcome: Extract<ByokOutcome, { kind: "generated" }>, cfg: GenCfg): Response {
  const u = assetUrls(outcome.asset, cfg.assetBaseUrl);
  return Response.json({
    created: cfg.now(),
    data: [{ url: u.url }],
    shared_cache: {
      result: "generated",
      similarity: 1,
      cost_saved_usd: 0,
      model_used: outcome.asset.model_used,
      source: outcome.asset.source,
      sizes: { thumb: u.thumb_url, medium: u.medium_url, large: u.url },
      original_url: u.original_url,
      byok: { used: outcome.used, cap: outcome.cap, est_spend_usd: outcome.estSpendUsd },
    },
  });
}
```

In the **empty-pool branch** (`if (!best || !asset)`), before the existing `recordQuery`:

```ts
    const b = await runByok(byok, generateOnMiss, prompt, vec, s);
    if (b.outcome?.kind === "content_policy") {
      return Response.json({ error: "content_policy", category: b.outcome.category }, { status: 400 });
    }
    if (b.outcome?.kind === "generated") {
      try {
        await s.queries.recordQuery({ normalized, original: prompt, assetId: b.outcome.asset.id, similarity: 1, built: true, generate: false });
      } catch (e) { console.error("recordQuery failed", e); }
      return generatedResponse(b.outcome, cfg);
    }
```

and extend the existing 202 body's `shared_cache` with:

```ts
        ...(b.fallbackStatus ? { byok: { status: b.fallbackStatus } } : {}),
```

In the **matched branch**, after `const isHit = best.score >= floor;` add:

```ts
  if (!isHit) {
    const b = await runByok(byok, generateOnMiss, prompt, vec, s);
    if (b.outcome?.kind === "content_policy") {
      return Response.json({ error: "content_policy", category: b.outcome.category }, { status: 400 });
    }
    if (b.outcome?.kind === "generated") {
      try {
        await s.queries.recordQuery({ normalized, original: prompt, assetId: b.outcome.asset.id, similarity: 1, built: true, generate: false });
      } catch (e) { console.error("recordQuery failed", e); }
      return generatedResponse(b.outcome, cfg);
    }
    byokFallbackStatus = b.fallbackStatus;
  }
```

declaring `let byokFallbackStatus: string | null = null;` just above, and extending the approximate response's `shared_cache` spread with:

```ts
      ...(byokFallbackStatus ? { byok: { status: byokFallbackStatus } } : {}),
```

- [ ] **Step 4: Run the full suite + types**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: all PASS (existing handler tests unchanged — the 4th arg is optional), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/handler.ts projects/worker/test/handler.test.ts
git commit -m "feat(byok): below-tolerance BYOK generation in handleGenerate"
```

---

### Task 9: Key-management routes, `/v1/me` block, router + env wiring

**Files:**
- Create: `projects/worker/src/byok-routes.ts`
- Modify: `projects/worker/src/auth-routes.ts:72-86` (`handleMe`)
- Modify: `projects/worker/src/types.ts` (`Env` additions)
- Modify: `projects/worker/src/index.ts` (routes + byok ctx at the generation call site)
- Modify: `projects/worker/wrangler.toml` (R2 binding + var)
- Modify: `projects/worker/.dev.vars.example`
- Test: `projects/worker/test/byok-routes.test.ts`, `projects/worker/test/auth-routes.test.ts` (append)

**Interfaces:**
- Consumes: `ByokStore` (2), `encryptSecret` (3), `providerFor` (5), `monthKey` (7), `resolveSession` (`src/session.ts:58`), `contract.byok_providers`.
- Produces:

```ts
// src/byok-routes.ts
export type ValidateKey = (provider: string, apiKey: string) => Promise<boolean>;
export async function byokView(s: Services, userId: string, nowSec: number): Promise<object | null>;
export async function handlePutByok(request: Request, env: Env, s: Services, validate?: ValidateKey): Promise<Response>;
export async function handlePatchByok(request: Request, env: Env, s: Services): Promise<Response>;
export async function handleDeleteByok(request: Request, env: Env, s: Services): Promise<Response>;
```

- `Env` gains: `BYOK_KEK?: string; OPENAI_API_KEY?: string; BYOK_PUBLIC_URL_BASE?: string; BYOK_ORIGINALS?: R2Bucket;`
- `/v1/me` response gains `byok: <byokView result> | null`.

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/byok-routes.test.ts`:

```ts
import { it, expect } from "vitest";
import { handlePutByok, handlePatchByok, handleDeleteByok, byokView } from "../src/byok-routes";
import { decryptSecret } from "../src/crypto";
import { fakeServices } from "./fakes";
import type { Env } from "../src/types";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const env = { BYOK_KEK: KEK } as Env;

function sessionServices(userId = "u1") {
  const s = fakeServices();
  s.sessions.resolve = async () => ({ user_id: userId });
  return s;
}
const put = (body: unknown) => new Request("https://x/v1/byok", {
  method: "PUT", headers: { Cookie: "wagmi_session=tok", "Content-Type": "application/json" }, body: JSON.stringify(body),
});

it("PUT requires a session", async () => {
  const s = fakeServices(); // resolve -> null
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  expect(res.status).toBe(401);
});

it("PUT validates and stores the key encrypted with last4 + defaults", async () => {
  const s = sessionServices();
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  expect(res.status).toBe(200);
  const row = (s as any)._byokRows.get("u1");
  expect(row.key_last4).toBe("2345");
  expect(row.monthly_cap).toBe(50);
  expect(row.key_ciphertext).not.toContain("sk-user");
  expect(await decryptSecret(row.key_ciphertext, KEK)).toBe("sk-user-12345");
  const body: any = await res.json();
  expect(body.byok.key_last4).toBe("2345");
  expect(body.byok.price_per_image).toBeCloseTo(0.04);
});

it("PUT rejects a key the provider refuses", async () => {
  const s = sessionServices();
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-bad-12345" }), env, s, async () => false);
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("key_rejected");
  expect((s as any)._byokRows.size).toBe(0);
});

it("PUT validates provider / api_key / monthly_cap / enabled", async () => {
  const s = sessionServices();
  const v = async () => true;
  expect((await handlePutByok(put({ provider: "google", api_key: "sk-user-12345" }), env, s, v)).status).toBe(422);
  expect((await handlePutByok(put({ provider: "openai", api_key: "short" }), env, s, v)).status).toBe(422);
  expect((await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345", monthly_cap: 0 }), env, s, v)).status).toBe(422);
  expect((await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345", enabled: "yes" }), env, s, v)).status).toBe(422);
});

it("PUT 503s without BYOK_KEK configured", async () => {
  const s = sessionServices();
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), {} as Env, s, async () => true);
  expect(res.status).toBe(503);
});

it("PATCH updates cap/enabled; 404 without a key", async () => {
  const s = sessionServices();
  const patch = (body: unknown) => new Request("https://x/v1/byok", { method: "PATCH", headers: { Cookie: "wagmi_session=tok" }, body: JSON.stringify(body) });
  expect((await handlePatchByok(patch({ monthly_cap: 10 }), env, s)).status).toBe(404);
  await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  const res = await handlePatchByok(patch({ monthly_cap: 10, enabled: false }), env, s);
  expect(res.status).toBe(200);
  const row = (s as any)._byokRows.get("u1");
  expect(row.monthly_cap).toBe(10);
  expect(row.enabled).toBe(0);
});

it("DELETE removes the key; usage rows survive", async () => {
  const s = sessionServices();
  await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  await s.byok.reserve("u1", "2026-07", 50);
  const res = await handleDeleteByok(new Request("https://x/v1/byok", { method: "DELETE", headers: { Cookie: "wagmi_session=tok" } }), env, s);
  expect(res.status).toBe(200);
  expect((s as any)._byokRows.size).toBe(0);
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(1);
});

it("byokView reports usage and price; null without a key", async () => {
  const s = sessionServices();
  const NOW = 1783468800; // 2026-07-08 UTC -> monthKey "2026-07"
  expect(await byokView(s, "u1", NOW)).toBeNull();
  await handlePutByok(put({ provider: "gmicloud", api_key: "gmi-key-12345" }), env, s, async () => true);
  await s.byok.reserve("u1", "2026-07", 50);
  await s.byok.addSpend("u1", "2026-07", 0.055);
  const v: any = await byokView(s, "u1", NOW);
  expect(v).toMatchObject({ provider: "gmicloud", used_this_month: 1, monthly_cap: 50, enabled: true, last_error: null });
  expect(v.est_spend_usd).toBeCloseTo(0.06); // rounded to cents
  expect(v.price_per_image).toBeCloseTo(0.055);
});
```

Append to `projects/worker/test/auth-routes.test.ts` (match its existing `handleMe` test setup — it already builds a session + user fake):

```ts
it("me includes the byok block when a key exists", async () => {
  // clone the file's existing happy-path handleMe arrangement, then:
  await s.byok.put({ userId: "u1", provider: "openai", keyCiphertext: "ct", keyLast4: "2345", monthlyCap: 50, enabled: true });
  const res = await handleMe(reqWithSession, env, s);
  const body: any = await res.json();
  expect(body.byok).toMatchObject({ provider: "openai", key_last4: "2345" });
});
```

(Adapt `s` / `reqWithSession` / `env` to the local helper names in that file; the fake user id must match `"u1"` or use the id the file's session fake returns.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/byok-routes.test.ts test/auth-routes.test.ts`
Expected: FAIL — module not found / no `byok` in `/v1/me` body.

- [ ] **Step 3: Implement `src/byok-routes.ts`**

```ts
import type { Env, Services } from "./types";
import { resolveSession } from "./session";
import { encryptSecret } from "./crypto";
import { providerFor } from "./providers";
import { monthKey } from "./byok";
import contract from "../../../contract.json";

// Key management is session-cookie only: you manage your provider key from
// the account page, never with a bearer key (a leaked sc- key must not be
// able to read, replace, or redirect provider spend).
export type ValidateKey = (provider: string, apiKey: string) => Promise<boolean>;
const defaultValidate: ValidateKey = (provider, apiKey) => providerFor(provider).validateKey(apiKey);
const PROVIDERS = new Set(["openai", "gmicloud"]);

export async function byokView(s: Services, userId: string, nowSec: number): Promise<{
  provider: string; key_last4: string; enabled: boolean; monthly_cap: number;
  used_this_month: number; est_spend_usd: number; price_per_image: number | null; last_error: string | null;
} | null> {
  const row = await s.byok.get(userId);
  if (!row) return null;
  const usage = await s.byok.getUsage(userId, monthKey(nowSec));
  const pinned = (contract as any).byok_providers[row.provider];
  return {
    provider: row.provider, key_last4: row.key_last4, enabled: !!row.enabled,
    monthly_cap: row.monthly_cap, used_this_month: usage.count,
    est_spend_usd: Math.round(usage.est_spend_usd * 100) / 100,
    price_per_image: pinned?.price_per_image_usd ?? null,
    last_error: row.last_error,
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function handlePutByok(request: Request, env: Env, s: Services, validate: ValidateKey = defaultValidate): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  if (!env.BYOK_KEK) return Response.json({ error: "BYOK is not configured on this deployment" }, { status: 503 });
  const ok = await s.rateLimiter.limit(`byok:ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`);
  if (!ok) return Response.json({ error: "Too many requests" }, { status: 429 });

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const provider = body?.provider;
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
    return Response.json({ error: "provider must be 'openai' or 'gmicloud'" }, { status: 422 });
  }
  const apiKey = body?.api_key;
  if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 300) {
    return Response.json({ error: "api_key must be a string of 8-300 characters" }, { status: 422 });
  }
  const cap = body?.monthly_cap ?? 50;
  if (!Number.isInteger(cap) || cap < 1 || cap > 10000) {
    return Response.json({ error: "monthly_cap must be an integer between 1 and 10000" }, { status: 422 });
  }
  const enabled = body?.enabled ?? true;
  if (typeof enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });

  let valid = false;
  try { valid = await validate(provider, apiKey); } catch (e) { console.error("byok key validation errored", e); }
  if (!valid) return Response.json({ error: "key_rejected", detail: "the provider did not accept this key" }, { status: 400 });

  await s.byok.put({
    userId: principal.userId, provider,
    keyCiphertext: await encryptSecret(apiKey, env.BYOK_KEK),
    keyLast4: apiKey.slice(-4), monthlyCap: cap, enabled,
  });
  return Response.json({ byok: await byokView(s, principal.userId, nowSec()) });
}

export async function handlePatchByok(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const f: { enabled?: boolean; monthlyCap?: number } = {};
  if (body?.enabled != null) {
    if (typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });
    f.enabled = body.enabled;
  }
  if (body?.monthly_cap != null) {
    if (!Number.isInteger(body.monthly_cap) || body.monthly_cap < 1 || body.monthly_cap > 10000) {
      return Response.json({ error: "monthly_cap must be an integer between 1 and 10000" }, { status: 422 });
    }
    f.monthlyCap = body.monthly_cap;
  }
  if (!(await s.byok.get(principal.userId))) return Response.json({ error: "no BYOK key on this account" }, { status: 404 });
  await s.byok.patch(principal.userId, f);
  return Response.json({ byok: await byokView(s, principal.userId, nowSec()) });
}

export async function handleDeleteByok(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  await s.byok.delete(principal.userId);
  return Response.json({ status: "ok" });
}
```

- [ ] **Step 4: Wire `handleMe`, router, env, config**

`src/auth-routes.ts` — import `byokView` from `./byok-routes` and extend `handleMe`'s `Response.json` object with:

```ts
    byok: await byokView(s, principal.userId, Math.floor(Date.now() / 1000)),
```

`src/types.ts` — extend `Env`:

```ts
  /** BYOK: 32-byte base64 KEK for user provider keys (wrangler secret). */
  BYOK_KEK?: string;
  /** BYOK: operator OpenAI key for moderating gmicloud-key users (wrangler secret). */
  OPENAI_API_KEY?: string;
  /** BYOK: public base URL of the BYOK_ORIGINALS bucket. */
  BYOK_PUBLIC_URL_BASE?: string;
  BYOK_ORIGINALS?: R2Bucket;
```

`src/index.ts`:

```ts
import { handlePutByok, handlePatchByok, handleDeleteByok } from "./byok-routes";
import type { ByokCfg } from "./byok";
```

routes (next to the billing routes):

```ts
      if (url.pathname === "/v1/byok") {
        if (request.method === "PUT") return await handlePutByok(request, env, services);
        if (request.method === "PATCH") return await handlePatchByok(request, env, services);
        if (request.method === "DELETE") return await handleDeleteByok(request, env, services);
      }
```

generation call site — replace `return await handleGenerate(body, services, cfg);` with:

```ts
        // BYOK is active only when fully configured; master/dev principals have
        // no byok row and fall through to "skipped" inside the orchestrator.
        const byokCtx = env.BYOK_KEK && env.BYOK_ORIGINALS && env.BYOK_PUBLIC_URL_BASE
          ? {
              userId: principal.userId,
              cfg: {
                kek: env.BYOK_KEK, moderationKey: env.OPENAI_API_KEY,
                bucket: env.BYOK_ORIGINALS, publicUrlBase: env.BYOK_PUBLIC_URL_BASE,
                now: cfg.now,
              } satisfies ByokCfg,
            }
          : null;
        return await handleGenerate(body, services, cfg, byokCtx);
```

`wrangler.toml` — after the Vectorize blocks:

```toml
# R2 — originals for BYOK in-request generation. Serve the bucket publicly
# (custom domain or r2.dev) and point BYOK_PUBLIC_URL_BASE at it. The
# demand-first rehost derives thumb/medium/large into B2 later (0008).
[[r2_buckets]]
binding = "BYOK_ORIGINALS"
bucket_name = "wagmiphotos-byok-originals"
```

and in `[vars]`:

```toml
BYOK_PUBLIC_URL_BASE = "https://byok.wagmi.photos"  # public origin of the BYOK_ORIGINALS R2 bucket
```

and extend the secrets comment line to include `BYOK_KEK, OPENAI_API_KEY`.

`.dev.vars.example` — append:

```
# BYOK (optional locally): base64 of 32 random bytes — openssl rand -base64 32
BYOK_KEK=
# Operator OpenAI key: moderates prompts for gmicloud-key users
OPENAI_API_KEY=
BYOK_PUBLIC_URL_BASE=http://localhost:8787/byok-dev
```

- [ ] **Step 5: Run the full suite + types**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: all PASS, tsc clean. (If `test/router.test.ts` snapshot-tests unknown `/v1/` routes, confirm it still passes — `/v1/byok` with `GET` should 404 as before.)

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/byok-routes.ts projects/worker/src/auth-routes.ts projects/worker/src/types.ts projects/worker/src/index.ts projects/worker/wrangler.toml projects/worker/.dev.vars.example projects/worker/test/byok-routes.test.ts projects/worker/test/auth-routes.test.ts
git commit -m "feat(byok): key-management API, /v1/me block, router + env wiring"
```

---

### Task 10: Account UI card + playground badge

**Files:**
- Modify: `projects/worker/public/index.html`
  - Card HTML after the Plan card (insert after line ~3113, `</div>` of the Plan card)
  - JS next to `renderPlan()` (~line 4361)
  - `/v1/me` consumption: find with `grep -n "currentPlan" public/index.html` — add `currentByok` alongside
  - Account route `onShow` (~line 3876): call `renderByok()` next to `renderPlan()`
  - Playground render in `generateImage()` (~lines 4552-4614) + badge CSS (~line 1848)

No unit tests (vanilla-JS SPA has none); verification is manual via `wrangler dev` in Task 11.

- [ ] **Step 1: Add the card HTML** (directly after the Plan card's closing `</div>`):

```html
      <!-- BYOK Card -->
      <div class="glass-card">
        <h2 class="card-title">Bring your own key</h2>
        <p style="font-size: 0.8125rem; color: var(--muted); margin-bottom: 14px;">
          Add your own OpenAI or GMI Cloud API key and the playground generates a fresh image whenever the library has no close-enough match. Generated images join the shared library. Spend shown is an estimate (images × list price) — your provider bills you directly.
        </p>
        <div id="byok-body" style="font-size: 0.9375rem; color: var(--muted);">Loading…</div>
      </div>
```

- [ ] **Step 2: Add the JS** (next to `renderPlan()`):

```js
    let currentByok = null; // set wherever currentPlan is set from /v1/me: currentByok = data.byok ?? null;

    function renderByok() {
      const el = document.getElementById('byok-body');
      if (!el) return;
      if (!currentByok) {
        el.innerHTML = `<div class="form-group">
          <label>Provider</label>
          <select id="byok-provider" style="height:40px;">
            <option value="openai">OpenAI</option>
            <option value="gmicloud">GMI Cloud</option>
          </select>
          <label style="margin-top:10px;">API key</label>
          <input id="byok-key" type="password" autocomplete="off" placeholder="sk-…" style="height:40px;font-family:var(--font-mono);">
          <label style="margin-top:10px;">Monthly image cap</label>
          <input id="byok-cap" type="number" min="1" max="10000" value="50" style="height:40px;width:120px;">
          <button class="btn btn-primary" style="height:40px;width:auto;padding:0 18px;margin-top:14px;" onclick="saveByok(this)">Save key</button>
        </div>`;
        return;
      }
      const b = currentByok;
      const providerName = b.provider === 'openai' ? 'OpenAI' : 'GMI Cloud';
      const price = b.price_per_image != null ? ` · ~$${Number(b.price_per_image).toFixed(3).replace(/0$/, '')}/image` : '';
      const err = b.last_error
        ? `<div style="color:var(--danger);font-size:0.8125rem;margin-bottom:10px;">Your ${providerName} key was rejected by the provider and has been disabled — delete it and enter a new one.</div>`
        : '';
      el.innerHTML = `${err}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div>
            <b style="color:var(--ink);">${providerName}</b>
            <span style="font-family:var(--font-mono);"> ••••${escapeHtml(b.key_last4)}</span>
            <span> · ${b.used_this_month} / ${b.monthly_cap} images this month · est. $${Number(b.est_spend_usd).toFixed(2)} spent${price}</span>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <label style="display:flex;gap:6px;align-items:center;font-size:0.8125rem;cursor:pointer;">
              <input type="checkbox" ${b.enabled ? 'checked' : ''} onchange="patchByok({ enabled: this.checked })"> Enabled
            </label>
            <input type="number" min="1" max="10000" value="${b.monthly_cap}" title="Monthly image cap" style="height:34px;width:90px;" onchange="patchByok({ monthly_cap: parseInt(this.value, 10) || ${b.monthly_cap} })">
            <button class="btn" style="height:34px;width:auto;padding:0 12px;" onclick="deleteByok(this)">Delete</button>
          </div>
        </div>`;
    }

    async function saveByok(btn) {
      const provider = document.getElementById('byok-provider')?.value;
      const key = document.getElementById('byok-key')?.value?.trim();
      const cap = parseInt(document.getElementById('byok-cap')?.value, 10) || 50;
      if (!key) { showToast('Enter an API key first', 'error'); return; }
      if (btn) { btn.disabled = true; btn.textContent = 'Checking key…'; }
      try {
        const r = await fetch('/v1/byok', {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, api_key: key, monthly_cap: cap }),
        });
        if (r.status === 401) { location.hash = '#/login'; return; }
        const data = await r.json();
        if (r.status === 400 && data.error === 'key_rejected') { showToast('The provider rejected this key', 'error'); return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        currentByok = data.byok;
        renderByok();
        showToast('Key saved — fresh generation is on', 'success');
      } catch {
        showToast('Could not save the key', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save key'; }
      }
    }

    async function patchByok(fields) {
      try {
        const r = await fetch('/v1/byok', {
          method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
        if (r.status === 401) { location.hash = '#/login'; return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        currentByok = (await r.json()).byok;
      } catch {
        showToast('Could not update BYOK settings', 'error');
      }
      renderByok();
    }

    async function deleteByok(btn) {
      if (!confirm('Delete your provider key? Fresh generation stops immediately; usage history is kept.')) return;
      if (btn) btn.disabled = true;
      try {
        const r = await fetch('/v1/byok', { method: 'DELETE', credentials: 'same-origin' });
        if (r.status === 401) { location.hash = '#/login'; return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        currentByok = null;
        renderByok();
      } catch {
        showToast('Could not delete the key', 'error');
        if (btn) btn.disabled = false;
      }
    }
```

- [ ] **Step 3: Wire data + route**

1. `grep -n "currentPlan" public/index.html` — at every site where `currentPlan` is assigned from a `/v1/me` response, add `currentByok = data.byok ?? null;` (match the local variable name for the parsed body).
2. In the `#/account` route `onShow` handler (~line 3876, where `loadKeys()` and `renderPlan()` are called), add `renderByok();`.

- [ ] **Step 4: Playground badge + notices**

1. CSS, next to `.badge-approximate` (~line 1848):

```css
    .badge-generated { background: var(--success-tint); color: var(--success); border: 1px solid rgba(14, 138, 77, 0.3); }
```

2. In `generateImage()`'s render section (the code around lines 4552-4614 that sets `badge.className = \`result-badge badge-${sc.result}\``): the existing generic badge already renders `generated` once the CSS class exists. Add after the badge assignment (adapting `sc` and the details-container variable to the local names):

```js
        // BYOK notices: fresh generation + graceful-degrade statuses
        if (sc.result === 'generated' && sc.byok) {
          appendResultNote(`✨ Generated with your key — ${sc.byok.used} / ${sc.byok.cap} this month (est. $${Number(sc.byok.est_spend_usd).toFixed(2)})`);
        } else if (sc.byok && sc.byok.status === 'cap_reached') {
          appendResultNote('Your monthly BYOK cap is reached — showing the closest match instead. Raise the cap on the Account page.');
        } else if (sc.byok && sc.byok.status === 'provider_error') {
          appendResultNote('Your provider key failed — showing the closest match instead. Check the Account page.');
        }
```

where `appendResultNote` is this small helper added beside `generateImage()` (it appends a one-line muted note into the result-details container; reuse the container element the function already writes into):

```js
    function appendResultNote(text) {
      const details = document.querySelector('.result-details');
      if (!details) return;
      const note = document.createElement('div');
      note.style.cssText = 'font-size:0.8125rem;color:var(--muted);margin-top:8px;';
      note.textContent = text;
      details.appendChild(note);
    }
```

3. The `history-badge` row (~line 4212) already interpolates `item.result` — `generated` entries render with the default style; no change needed unless a `.history-badge.generated` color is desired:

```css
    .history-badge.generated { color: var(--success); background: var(--success-tint); }
```

Also handle the new 400: in `generateImage()`'s error handling (where non-OK responses become error messages), add:

```js
        if (response.status === 400 && payload && payload.error === 'content_policy') {
          throw new Error('This prompt was blocked by content policy (' + (payload.category || 'flagged') + ').');
        }
```

(adapting to how the function currently reads error bodies — if it doesn't parse JSON on failure, parse it for this case).

- [ ] **Step 5: Type-check + eyeball**

Run: `cd projects/worker && npx tsc --noEmit && npx vitest run`
Expected: unchanged PASS (the HTML is not type-checked; this guards against accidental TS edits).

- [ ] **Step 6: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(byok): account BYOK card (key, toggle, cap, spend meter) + playground badge"
```

---

### Task 11: Local smoke script, deploy runbook, final verification

**Files:**
- Create: `projects/worker/scripts/local-byok-smoke.py`
- Modify: `DEPLOY.md` (new "BYOK" section after the Stripe one)
- Modify: `docs/HANDOFF-2026-07-08-stripe-billing.md` — no change; instead append the BYOK deploy note to `DEPLOY.md` only.

**Interfaces:**
- Consumes: the running local worker (`npx wrangler dev --local --port 8787`), `.dev.vars` with `DEV_MODE=true` and `BYOK_KEK` set.
- Produces: `python3 scripts/local-byok-smoke.py` → `N/N checks passed`, exit 0.

Scope note: image generation itself cannot run under `wrangler dev --local` (no Workers AI / Vectorize — the embed step 500s before BYOK is reached; see the running-locally skill). The smoke test therefore covers the **key-management lifecycle** end-to-end and validates gating/validation behavior; the generation path is covered by unit tests (Tasks 7-8) and by post-deploy verification.

- [ ] **Step 1: Write `projects/worker/scripts/local-byok-smoke.py`**

Follow the structure of `scripts/local-billing-smoke.py` (dev-login via `dev_link`, cookie jar, `check(name, cond)` counter, exit non-zero on failure). Checks, in order:

```python
#!/usr/bin/env python3
"""BYOK key-management smoke test against a local `wrangler dev --local` worker.

Needs .dev.vars: DEV_MODE=true, PUBLIC_SITE_URL=http://localhost:8787,
BYOK_KEK=<base64 32 bytes>. Generation itself can't run locally (no Workers
AI/Vectorize) — this drives the key lifecycle: PUT (validated), /v1/me block,
PATCH cap/enabled, DELETE, auth gating. Provider validation is exercised with
an intentionally-bad key (expect key_rejected) and, when OPENAI_TEST_KEY is
exported, a real accept path.
"""
import json, os, sys, urllib.request

BASE = os.environ.get("BASE", "http://localhost:8787")
EMAIL = os.environ.get("EMAIL", "byok-smoke@example.com")
REAL_KEY = os.environ.get("OPENAI_TEST_KEY")  # optional

passed = failed = 0
def check(name, cond):
    global passed, failed
    passed += cond; failed += (not cond)
    print(("  ok " if cond else "FAIL ") + name)

# -- tiny cookie-carrying client (copy the helper from local-billing-smoke.py) --
# ... req(method, path, body=None, headers=None) -> (status, json_or_text, set_cookies)

# 1. dev login: POST /v1/auth/login {email} -> dev_link; GET it with the nonce cookie -> session cookie
# 2. unauthenticated PUT /v1/byok -> 401
# 3. authenticated PUT with provider "google" -> 422
# 4. authenticated PUT with a bad key -> 400 key_rejected  (openai rejects "sk-invalid-smoke-key")
# 5. GET /v1/me -> byok is null
# 6. if REAL_KEY: PUT {provider: openai, api_key: REAL_KEY, monthly_cap: 3} -> 200, byok.key_last4 == REAL_KEY[-4:]
# 7. if REAL_KEY: GET /v1/me -> byok.monthly_cap == 3, used_this_month == 0
# 8. if REAL_KEY: PATCH {enabled: false} -> 200, byok.enabled == False
# 9. if REAL_KEY: PATCH {monthly_cap: 7} -> 200, byok.monthly_cap == 7
# 10. if REAL_KEY: DELETE -> 200; GET /v1/me -> byok is null
# 11. PATCH with no key on the account -> 404

print(f"\n{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
```

Implement the `req` helper and the numbered checks fully (the comment block above is the required behavior, not the deliverable — every numbered line becomes a real request + `check(...)` call, copying the cookie/login mechanics from `local-billing-smoke.py`).

- [ ] **Step 2: Run it**

```bash
cd projects/worker
grep -q BYOK_KEK .dev.vars || echo "BYOK_KEK=$(openssl rand -base64 32)" >> .dev.vars
npx wrangler d1 migrations apply wagmiphotos --local
npx wrangler dev --local --port 8787 --ip 127.0.0.1 &   # leave running
python3 scripts/local-byok-smoke.py
```

Expected: all checks pass, exit 0 (checks 6-10 auto-skip without `OPENAI_TEST_KEY`).

- [ ] **Step 3: Add the DEPLOY.md "BYOK" section**

After the "Stripe billing" section, add:

```markdown
## BYOK (bring-your-own-key generation)

1. **Migration:** `npx wrangler d1 migrations apply wagmiphotos --remote` (adds `byok_keys` / `byok_usage`, 0013).
2. **R2 bucket:** `npx wrangler r2 bucket create wagmiphotos-byok-originals`, enable public access
   (custom domain preferred), and set `BYOK_PUBLIC_URL_BASE` in `wrangler.toml` `[vars]` to that origin.
3. **Secrets:**
   - `npx wrangler secret put BYOK_KEK` → `openssl rand -base64 32` output. Rotating it orphans all
     stored keys (decrypt fails → requests fall back, users re-enter keys); rotate only deliberately.
   - `npx wrangler secret put OPENAI_API_KEY` → operator key; moderates prompts for GMI-key users
     (same key the backfill box uses).
4. **Deploy:** `cd projects/worker && npm run deploy`.
5. **Verify:** add a real OpenAI key on `#/account`, set the cap to 2, run a playground prompt obscure
   enough to be below the floor → expect the ✨ generated badge, the meter at 1/2, the image in the
   library, and a second+third run to flip to `cap_reached`. Then delete the key.
```

- [ ] **Step 4: Final verification**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: full suite green (189 pre-existing + all new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/scripts/local-byok-smoke.py DEPLOY.md
git commit -m "feat(byok): local key-lifecycle smoke test + deploy runbook"
```

---

## Post-plan notes (not tasks)

- **Deferred (spec "Known limitations"):** no output-image moderation (prompt-level parity with backfill); one key per user; price constants drift until `contract.json` is edited; UTC month boundary.
- **Backfill interaction:** BYOK-generated rows record their query as `built`, so the demand queue never double-generates them; the rehost/derive pipeline treats `source='byok'` rows like any other non-cached asset (reads `source_url`).
- **Production `BYOK_PUBLIC_URL_BASE`** must serve the R2 bucket publicly *before* the first key is added, or generated `data[0].url` values 404.
