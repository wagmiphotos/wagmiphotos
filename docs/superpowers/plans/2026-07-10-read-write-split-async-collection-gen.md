# Read/Write Split + Async Collection Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the API into a pure closest-match read endpoint and a new async, BYOK-gated, collection-scoped creation endpoint (`202` + ticket + poll-through), merge the SPA's playground/library pages into one Library|Collections page, and make provider calls async-capable so gpt-image-2 can come back.

**Architecture:** `POST /v1/collections/:id/generations` gates (auth→ownership→moderation→atomic reserve), creates a D1 `generations` job row, submits to the provider (GMI = its native job queue; OpenAI = sync gpt-image-1 inside `ctx.waitUntil` until background mode is verified), and returns `202 {generation}`. `GET /v1/generations/:id` "polls through": each client poll performs one short provider status check under an atomic claim, and on completion publishes (R2 → D1 → Vectorize namespace) exactly once. A cron sweep re-drives or fails+refunds abandoned jobs. The read endpoint loses `cache_tolerance`/`generate_on_miss` and all BYOK plumbing.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, Vectorize, R2, vitest, single-file SPA (`public/index.html`), `node:sqlite` for real-schema tests.

**Spec:** `docs/superpowers/specs/2026-07-10-read-write-split-async-collection-gen-design.md`

## Global Constraints

- All worker code lives in `projects/worker/`. Run tests from there: `cd projects/worker && npm test`.
- `contract.json` (repo root) pins cross-language constants. `byok_providers` stays `openai: gpt-image-1 @ 0.04`, `gmicloud: gpt-image-2-generate @ 0.055` until Task 10's probe passes. `default_cache_tolerance: 0.15` stays (it becomes the pinned server default).
- **BYOK_KEK never leaves the worker.** All decryption happens in worker code paths.
- Asset reads MUST go through the `live_assets` view (migration 0008). Public read SQL must never SELECT `created_by`, `collection_id`, or `serve_count` (pinned by `test/byok-d1.test.ts`).
- The reserve→provider→publish→refund ordering from the old `tryByokGenerate` is load-bearing: guardrails fail closed, refund only between reserve and durable persist, never refund after `insertGenerated` succeeded.
- Public API has **no model parameter** (memory: wagmi-photos-branding). Don't add model/quality knobs anywhere.
- SPA conventions: raw `fetch('/v1/…', {credentials:'same-origin'})`, `escapeHtml()` for interpolation, `showToast()`, `.field-input` form styling, inline `onclick=` handlers, light black/red theme via CSS vars (`--ink`, `--paper`, `--line`, `--red`).
- Pre-launch: breaking API changes are fine; no deprecation shims.
- Commit after every task (at minimum). Messages follow the repo's `feat(scope):` style with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Real-schema D1 test harness

The fake-D1 tests validate nothing about real schemas — that's how the 0007 `url`-column bug shipped. This harness runs the REAL migrations in an in-memory SQLite (Node 22's built-in `node:sqlite`, verified working on this machine: v22.17.0) behind a minimal D1 adapter, and pays down the handoff debt with smoke tests for the existing write paths.

**Files:**
- Create: `projects/worker/test/real-d1.ts`
- Create: `projects/worker/test/d1-real-schema.test.ts`
- Modify: `projects/worker/test/node-shims.d.ts` (append module declaration)

**Interfaces:**
- Produces: `realDb(): any` — a D1Database-shaped object with every migration applied, plus `_raw` (the underlying `DatabaseSync`) for seeding. Later tasks add their real-schema tests to `d1-real-schema.test.ts`.

- [ ] **Step 1: Write the harness**

`projects/worker/test/real-d1.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// Node 22.5+ built-in. Emits an ExperimentalWarning on import — harmless.
import { DatabaseSync } from "node:sqlite";

// A real SQLite database with EVERY migration applied in order, adapted to
// the tiny D1Database surface makeD1Stores uses (prepare/bind/first/run/all
// + batch). Exists because fake-D1 tests validate nothing about the real
// schema — that's how the 0007 url-column bug shipped (HANDOFF-2026-07-10).
export function realDb(): any {
  // D1 enforces foreign keys; mirror that.
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const dir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith(".sql")) db.exec(readFileSync(join(dir, f), "utf8"));
  }
  const stmt = (sql: string) => ({
    _args: [] as any[],
    bind(...args: any[]) { this._args = args; return this; },
    async first() { const r = db.prepare(sql).get(...this._args); return r === undefined ? null : r; },
    async run() { db.prepare(sql).run(...this._args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...this._args) }; },
  });
  return {
    prepare: stmt,
    async batch(stmts: any[]) { const out: any[] = []; for (const s of stmts) out.push(await s.run()); return out; },
    _raw: db,
  };
}
```

- [ ] **Step 2: Append the type shim**

Append to `projects/worker/test/node-shims.d.ts`:

```ts
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, opts?: { enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): { get(...a: any[]): any; run(...a: any[]): any; all(...a: any[]): any[] };
  }
}
```

- [ ] **Step 3: Write the failing smoke tests**

`projects/worker/test/d1-real-schema.test.ts`:

```ts
import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";
import { realDb } from "./real-d1";

function seedUser(db: any, id = "usr_1") {
  db._raw.exec(`INSERT INTO users (id, email) VALUES ('${id}', '${id}@example.com')`);
}

it("insertGenerated writes a row the REAL schema accepts and live_assets exposes", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_1", ownerUserId: "usr_1", name: "Foxes", themePrompt: "watercolor" });
  await assets.insertGenerated({
    id: "a1", prompt: "a red fox", sourceUrl: "https://byok.example/byok/a1/original.webp",
    mime: "image/webp", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai",
    priceUsd: 0.04, createdBy: "usr_1", collectionId: "col_1",
  });
  const row = await assets.getAsset("a1");
  expect(row?.id).toBe("a1");
  const listed = await assets.listByCollection({ collectionId: "col_1", limit: 10, offset: 0 });
  expect(listed.map((r) => r.id)).toEqual(["a1"]);
});

it("tombstoneAsset hides the row from every live_assets read", async () => {
  const db = realDb();
  seedUser(db);
  const { assets } = makeD1Stores(db);
  await assets.insertGenerated({
    id: "a2", prompt: "a blue fox", sourceUrl: "https://byok.example/byok/a2/original.webp",
    mime: "image/webp", width: 1024, height: 1024, modelUsed: "gpt-image-1", provider: "openai",
    priceUsd: 0.04, createdBy: "usr_1", collectionId: null,
  });
  await assets.tombstoneAsset("a2");
  expect(await assets.getAsset("a2")).toBeNull();
});

it("byok reserve/refund round-trips against the real byok_usage schema", async () => {
  const db = realDb();
  seedUser(db);
  const { byok } = makeD1Stores(db);
  expect(await byok.reserve("usr_1", "2026-07", 2)).toBe(true);
  expect(await byok.reserve("usr_1", "2026-07", 2)).toBe(true);
  expect(await byok.reserve("usr_1", "2026-07", 2)).toBe(false); // cap spent
  await byok.refund("usr_1", "2026-07");
  expect((await byok.getUsage("usr_1", "2026-07")).count).toBe(1);
  expect(await byok.totalGenerated("usr_1")).toBe(1);
});
```

- [ ] **Step 4: Run the tests**

Run: `cd projects/worker && npx vitest run test/d1-real-schema.test.ts`
Expected: PASS (3 tests). If `node:sqlite` import fails, re-run with `NODE_OPTIONS=--experimental-sqlite`; if it still fails, stop and report — do not swap in a fake.

- [ ] **Step 5: Run the whole suite to confirm nothing broke**

Run: `npm test`
Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/test/real-d1.ts projects/worker/test/d1-real-schema.test.ts projects/worker/test/node-shims.d.ts
git commit -m "test(d1): real-schema harness over node:sqlite — migrations actually applied"
```

---

### Task 2: Migration 0016 + generations job store

**Files:**
- Create: `projects/worker/migrations/0016_generations.sql`
- Modify: `projects/worker/src/types.ts` (add GenerationRow/GenerationStore, extend Services)
- Modify: `projects/worker/src/d1.ts` (implement the store, export it from makeD1Stores)
- Modify: `projects/worker/src/index.ts:24` (destructure + pass `generations` into Services)
- Modify: `projects/worker/test/fakes.ts` (fake store)
- Test: `projects/worker/test/d1-real-schema.test.ts` (extend)

**Interfaces:**
- Produces:
  - `GenerationRow`: `{ id, user_id, collection_id, prompt, provider, provider_job_id: string|null, status: "queued"|"generating"|"succeeded"|"failed", asset_id: string|null, error: string|null, month, attempts: number, claimed_at: string|null, created_at, updated_at }`
  - `GenerationStore`: `create({id,userId,collectionId,prompt,provider,month})`, `get(id)`, `setProviderJob(id, providerJobId)`, `claim(id): Promise<boolean>` (atomic, 60s TTL), `release(id)`, `succeed(id, assetId): Promise<boolean>`, `fail(id, error): Promise<boolean>` (both return whether THIS call made the terminal transition — the refund guard), `listStale(olderThanSec, limit)`.
  - `Services.generations: GenerationStore`

- [ ] **Step 1: Write the migration**

`projects/worker/migrations/0016_generations.sql`:

```sql
-- Async BYOK generation jobs (spec 2026-07-10-read-write-split-async-collection-gen).
-- POST /v1/collections/:id/generations creates a row after the atomic quota
-- reserve; GET /v1/generations/:id drives it (poll-through) under the claim;
-- the cron sweep finishes abandoned rows. month records which byok_usage row
-- the reservation went into, so a terminal failure refunds the right month.
CREATE TABLE IF NOT EXISTS generations (
  id              TEXT PRIMARY KEY,                 -- 'gen_' + uuid
  user_id         TEXT NOT NULL REFERENCES users(id),
  collection_id   TEXT NOT NULL REFERENCES collections(id),
  prompt          TEXT NOT NULL,                    -- combined (user + theme) prompt
  provider        TEXT NOT NULL,                    -- 'openai' | 'gmicloud'
  provider_job_id TEXT,                             -- GMI request id / OpenAI response id; NULL while queued and for sync-mode jobs
  status          TEXT NOT NULL DEFAULT 'queued',   -- queued|generating|succeeded|failed
  asset_id        TEXT,
  error           TEXT,
  month           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_at      TEXT,                             -- drive claim (60s TTL); stale claims are reclaimable
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Sweep scans open jobs by staleness; owner GET checks are by primary key.
CREATE INDEX IF NOT EXISTS idx_generations_open ON generations(status, updated_at);
```

- [ ] **Step 2: Add the types**

In `projects/worker/src/types.ts`, after the `ByokStore` block (line ~114), add:

```ts
export interface GenerationRow {
  id: string; user_id: string; collection_id: string; prompt: string;
  provider: string; provider_job_id: string | null;
  status: "queued" | "generating" | "succeeded" | "failed";
  asset_id: string | null; error: string | null; month: string;
  attempts: number; claimed_at: string | null; created_at: string; updated_at: string;
}
export interface GenerationStore {
  create(g: { id: string; userId: string; collectionId: string; prompt: string; provider: string; month: string }): Promise<void>;
  get(id: string): Promise<GenerationRow | null>;
  /** Records the provider-side job id and moves queued -> generating. */
  setProviderJob(id: string, providerJobId: string): Promise<void>;
  /** Atomic drive claim (60s TTL): true when THIS caller may touch the provider.
   *  Also bumps attempts and refreshes updated_at (keeps the row out of listStale). */
  claim(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
  /** Terminal transitions are guarded (status IN queued/generating) and return
   *  whether THIS call transitioned — the caller refunds/accounts only on true. */
  succeed(id: string, assetId: string): Promise<boolean>;
  fail(id: string, error: string): Promise<boolean>;
  /** Open jobs whose updated_at is older than olderThanSec — sweep targets. */
  listStale(olderThanSec: number, limit: number): Promise<GenerationRow[]>;
}
```

And in `Services` (line ~123) add `generations: GenerationStore;` to the interface.

- [ ] **Step 3: Write failing real-schema tests**

Append to `projects/worker/test/d1-real-schema.test.ts`:

```ts
import type { GenerationRow } from "../src/types";

function seedGeneration(db: any) {
  seedUser(db);
  db._raw.exec(`INSERT INTO collections (id, owner_user_id, name, theme_prompt) VALUES ('col_g', 'usr_1', 'n', '')`);
}

it("generations: create -> setProviderJob -> succeed round-trips on the real schema", async () => {
  const db = realDb();
  seedGeneration(db);
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "gen_1", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  await generations.setProviderJob("gen_1", "req-9");
  let row = (await generations.get("gen_1")) as GenerationRow;
  expect(row.status).toBe("generating");
  expect(row.provider_job_id).toBe("req-9");
  expect(await generations.succeed("gen_1", "asset-1")).toBe(true);
  expect(await generations.succeed("gen_1", "asset-1")).toBe(false); // second transition loses
  row = (await generations.get("gen_1")) as GenerationRow;
  expect(row.status).toBe("succeeded");
  expect(row.asset_id).toBe("asset-1");
});

it("generations: fail transitions once (the refund guard) and claim is exclusive", async () => {
  const db = realDb();
  seedGeneration(db);
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "gen_2", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  expect(await generations.claim("gen_2")).toBe(true);
  expect(await generations.claim("gen_2")).toBe(false); // fresh claim blocks a second driver
  await generations.release("gen_2");
  expect(await generations.claim("gen_2")).toBe(true);  // released -> reclaimable
  expect(await generations.fail("gen_2", "boom")).toBe(true);
  expect(await generations.fail("gen_2", "boom")).toBe(false);
  expect(await generations.claim("gen_2")).toBe(false); // terminal rows are unclaimable
  const row = (await generations.get("gen_2"))!;
  expect(row.error).toBe("boom");
  expect(row.attempts).toBe(2);
});

it("generations: listStale returns only stale open jobs", async () => {
  const db = realDb();
  seedGeneration(db);
  const { generations } = makeD1Stores(db);
  await generations.create({ id: "gen_3", userId: "usr_1", collectionId: "col_g", prompt: "p", provider: "gmicloud", month: "2026-07" });
  expect((await generations.listStale(120, 10)).length).toBe(0); // too fresh
  db._raw.exec(`UPDATE generations SET updated_at = datetime('now', '-10 minutes') WHERE id = 'gen_3'`);
  expect((await generations.listStale(120, 10)).map((r: any) => r.id)).toEqual(["gen_3"]);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/d1-real-schema.test.ts`
Expected: FAIL — `makeD1Stores` has no `generations` (TS/undefined error).

- [ ] **Step 5: Implement the store**

In `projects/worker/src/d1.ts`: add `GenerationRow, GenerationStore` to the type import; add `generations: GenerationStore` to the return type of `makeD1Stores` and to the returned object. Implementation (place after the `collections` store):

```ts
  const GEN_COLS =
    "id, user_id, collection_id, prompt, provider, provider_job_id, status, asset_id, error, month, attempts, claimed_at, created_at, updated_at";
  const generations: GenerationStore = {
    async create(g) {
      await db.prepare(
        "INSERT INTO generations (id, user_id, collection_id, prompt, provider, month) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(g.id, g.userId, g.collectionId, g.prompt, g.provider, g.month).run();
    },
    async get(id) {
      const row = await db.prepare(`SELECT ${GEN_COLS} FROM generations WHERE id = ?`).bind(id).first<GenerationRow>();
      return row ?? null;
    },
    async setProviderJob(id, providerJobId) {
      await db.prepare(
        "UPDATE generations SET provider_job_id = ?, status = 'generating', updated_at = datetime('now') WHERE id = ? AND status = 'queued'"
      ).bind(providerJobId, id).run();
    },
    // Single guarded UPDATE = the atomic claim (same shape as byok.reserve):
    // two concurrent polls cannot both drive the provider. Stale (>60s) claims
    // are reclaimable so a crashed driver never wedges the job.
    async claim(id) {
      const row = await db.prepare(
        `UPDATE generations SET claimed_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
         WHERE id = ? AND status IN ('queued','generating')
           AND (claimed_at IS NULL OR claimed_at < datetime('now','-60 seconds'))
         RETURNING id`
      ).bind(id).first();
      return !!row;
    },
    async release(id) {
      await db.prepare("UPDATE generations SET claimed_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(id).run();
    },
    async succeed(id, assetId) {
      const row = await db.prepare(
        "UPDATE generations SET status = 'succeeded', asset_id = ?, claimed_at = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('queued','generating') RETURNING id"
      ).bind(assetId, id).first();
      return !!row;
    },
    async fail(id, error) {
      const row = await db.prepare(
        "UPDATE generations SET status = 'failed', error = ?, claimed_at = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('queued','generating') RETURNING id"
      ).bind(error, id).first();
      return !!row;
    },
    async listStale(olderThanSec, limit) {
      const { results } = await db.prepare(
        `SELECT ${GEN_COLS} FROM generations WHERE status IN ('queued','generating') AND updated_at < datetime('now', ?) ORDER BY updated_at ASC LIMIT ?`
      ).bind(`-${olderThanSec} seconds`, limit).all<GenerationRow>();
      return results ?? [];
    },
  };
```

In `projects/worker/src/index.ts:24`, add `generations` to the destructure and to the returned Services object (line ~43).

- [ ] **Step 6: Add the fake store**

In `projects/worker/test/fakes.ts`: import `GenerationRow`, add near the other maps:

```ts
  const generationRows = new Map<string, GenerationRow>();
```

Add to the `base` Services object (claim here is simplified: any live claim blocks — the 60s-stale reclaim is only exercised by the real-schema tests):

```ts
    generations: {
      create: async (g) => {
        generationRows.set(g.id, {
          id: g.id, user_id: g.userId, collection_id: g.collectionId, prompt: g.prompt,
          provider: g.provider, provider_job_id: null, status: "queued", asset_id: null,
          error: null, month: g.month, attempts: 0, claimed_at: null,
          created_at: "2026-07-10 00:00:00", updated_at: "2026-07-10 00:00:00",
        });
      },
      get: async (id) => generationRows.get(id) ?? null,
      setProviderJob: async (id, pj) => {
        const r = generationRows.get(id);
        if (r && r.status === "queued") { r.provider_job_id = pj; r.status = "generating"; }
      },
      claim: async (id) => {
        const r = generationRows.get(id);
        if (!r || (r.status !== "queued" && r.status !== "generating") || r.claimed_at) return false;
        r.claimed_at = "claimed"; r.attempts += 1; return true;
      },
      release: async (id) => { const r = generationRows.get(id); if (r) r.claimed_at = null; },
      succeed: async (id, assetId) => {
        const r = generationRows.get(id);
        if (!r || (r.status !== "queued" && r.status !== "generating")) return false;
        r.status = "succeeded"; r.asset_id = assetId; r.claimed_at = null; return true;
      },
      fail: async (id, error) => {
        const r = generationRows.get(id);
        if (!r || (r.status !== "queued" && r.status !== "generating")) return false;
        r.status = "failed"; r.error = error; r.claimed_at = null; return true;
      },
      listStale: async (_olderThanSec, limit) =>
        [...generationRows.values()].filter((r) => r.status === "queued" || r.status === "generating").slice(0, limit),
    },
```

And expose `(base as any)._generationRows = generationRows;` with the other internals.

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/d1-real-schema.test.ts && npm test`
Expected: new tests PASS; whole suite PASS (typecheck of fakes is exercised by the suite compiling).

- [ ] **Step 8: Apply the migration locally**

Run: `npx wrangler d1 migrations apply wagmiphotos --local`
Expected: `0016_generations.sql` applied without error.

- [ ] **Step 9: Commit**

```bash
git add projects/worker/migrations/0016_generations.sql projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/src/index.ts projects/worker/test/fakes.ts projects/worker/test/d1-real-schema.test.ts
git commit -m "feat(gen): migration 0016 + generations job store (atomic claim, once-only terminal transitions)"
```

---

### Task 3: Provider layer — async/sync split (GMI submit/check)

Split `ImageProvider` into async (submit/check) and sync (generate) modes. GMI becomes async — its existing submit→poll→download loop is decomposed so each call is one short connection (the proven backfill pattern). OpenAI keeps its current streaming `generate()` untouched, tagged `mode: "sync"` (gpt-image-1 ducks the ~20s idle-kill; Task 10 may upgrade it).

**Files:**
- Modify: `projects/worker/src/providers.ts`
- Test: `projects/worker/test/providers.test.ts` (rewrite GMI generate-loop tests as submit/check tests)

**Interfaces:**
- Produces (exact exports later tasks consume):

```ts
export type ProviderJobState =
  | { state: "pending" }
  | { state: "done"; image: GeneratedImage }
  | { state: "failed"; error: string };
export interface AsyncImageProvider {
  mode: "async";
  submit(prompt: string, apiKey: string): Promise<string>;   // provider job id
  check(jobId: string, apiKey: string): Promise<ProviderJobState>; // ONE short status call (+download on success)
  validateKey(apiKey: string): Promise<boolean>;
}
export interface SyncImageProvider {
  mode: "sync";
  generate(prompt: string, apiKey: string): Promise<GeneratedImage>;
  validateKey(apiKey: string): Promise<boolean>;
}
export type ImageProvider = AsyncImageProvider | SyncImageProvider;
export function providerFor(name: string, fetchFn?: typeof fetch): ImageProvider;
```

- Consumers to keep compiling: `src/byok.ts` (`provider.generate(...)` — see Step 4), `src/byok-routes.ts` (`providerFor(...).validateKey`).

- [ ] **Step 1: Write failing tests for the GMI split**

In `projects/worker/test/providers.test.ts`, add (keep existing OpenAI tests; delete GMI tests that drive the old single-call `generate` loop — they are replaced by these):

```ts
import { providerFor, ProviderAuthError, type AsyncImageProvider } from "../src/providers";

function gmi(): AsyncImageProvider {
  return providerFor("gmicloud", fetchStub as any) as AsyncImageProvider;
}
// fetchStub: reuse this file's existing fetch-stubbing helper; if none fits,
// build a queue-based stub: const responses: Response[] = []; const fetchStub =
// async () => responses.shift()!;

it("gmicloud is an async provider", () => {
  expect(gmi().mode).toBe("async");
});

it("gmi submit posts the pinned model and returns the request id", async () => {
  // stub: 200 {"request_id":"req-1"}
  // assert returned "req-1"; assert body JSON model === "gpt-image-2-generate"
});

it("gmi submit throws ProviderAuthError on 401/403", async () => {
  // stub 401 -> expect rejects.toThrow(ProviderAuthError)
});

it("gmi check maps status running -> pending", async () => {
  // stub: 200 {"status":"running"} -> {state:"pending"}
});

it("gmi check maps failed/cancelled -> failed with the provider error", async () => {
  // stub: 200 {"status":"failed","error":"nsfw"} -> {state:"failed", error: contains "nsfw"}
});

it("gmi check downloads on success and enforces the mime/size guards", async () => {
  // stub 1: 200 {"status":"success","outcome":{"media_urls":["https://x/img.png"]}}
  // stub 2: image bytes with Content-Type image/png -> {state:"done", image:{mime:"image/png"}}
  // then repeat with Content-Type text/html -> rejects (mime guard)
});
```

Write these as real tests following the stubbing style already in `providers.test.ts` (it stubs `fetchFn`); the bullet comments above describe each stub/assert pair — implement them fully, no pseudocode left behind.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/providers.test.ts`
Expected: FAIL — `mode`/`submit`/`check` don't exist.

- [ ] **Step 3: Implement the split in providers.ts**

Replace the `ImageProvider` interface block (lines 5–10) with the interfaces from the **Interfaces** section above (keep `GeneratedImage`, `ProviderAuthError`). Delete the `Sleep` type, `realSleep`, `GMI_POLL_MS`, `GMI_DEADLINE_MS` (no more in-process polling loop). In `makeOpenAiProvider`, add `mode: "sync" as const,` as the first property; everything else stays byte-identical. Rewrite `makeGmiProvider`:

```ts
function makeGmiProvider(fetchFn: typeof fetch): AsyncImageProvider {
  const headers = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
  return {
    mode: "async",
    async submit(prompt, apiKey) {
      const submit = await fetchFn(`${GMI_QUEUE}/requests`, {
        method: "POST", headers: headers(apiKey),
        body: JSON.stringify({ model: PINNED.gmicloud.model, payload: { prompt, size: "1024x1024" } }),
        signal: AbortSignal.timeout(GMI_SUBMIT_TIMEOUT_MS),
      });
      if (submit.status === 401 || submit.status === 403) throw new ProviderAuthError(`gmicloud ${submit.status}`);
      if (!submit.ok) throw new Error(`gmicloud submit ${submit.status}: ${(await submit.text().catch(() => "")).slice(0, 300)}`);
      const sub: any = await submit.json();
      const id = sub?.request_id ?? sub?.id;
      if (!id) throw new Error("gmicloud submit: no request id");
      return String(id);
    },
    // ONE status call per invocation; the caller (poll-through GET / sweep)
    // owns the cadence. Download only happens on the success transition.
    async check(jobId, apiKey) {
      const poll = await fetchFn(`${GMI_QUEUE}/requests/${jobId}`, {
        headers: headers(apiKey), signal: AbortSignal.timeout(GMI_POLL_TIMEOUT_MS),
      });
      if (poll.status === 401 || poll.status === 403) throw new ProviderAuthError(`gmicloud ${poll.status}`);
      if (!poll.ok) throw new Error(`gmicloud poll ${poll.status}`);
      const detail: any = await poll.json();
      const status = String(detail?.status ?? "");
      if (status === "failed" || status === "cancelled") {
        return { state: "failed", error: `gmicloud generation ${status}: ${String(detail?.error ?? "")}`.slice(0, 300) };
      }
      if (status !== "success") return { state: "pending" };
      const raw = detail?.outcome?.media_urls;
      const first = Array.isArray(raw)
        ? (typeof raw[0] === "string" ? raw[0] : raw[0]?.url)
        : (detail?.outcome?.image_url ?? detail?.outcome?.url);
      if (!first) throw new Error("gmicloud: success but no image url");
      const img = await fetchFn(first, { signal: AbortSignal.timeout(GMI_DOWNLOAD_TIMEOUT_MS) });
      if (!img.ok) throw new Error(`gmicloud image fetch ${img.status}`);
      const rawType = img.headers.get("Content-Type");
      const mime = rawType ? rawType.split(";")[0].trim() : "image/png";
      if (rawType && !GMI_ALLOWED_MIME.has(mime)) throw new Error(`gmicloud: unexpected content type ${mime}`);
      const declaredLen = img.headers.get("Content-Length");
      if (declaredLen && Number(declaredLen) > GMI_MAX_IMAGE_BYTES) throw new Error(`gmicloud: image too large (${declaredLen} bytes)`);
      const bytes = await img.arrayBuffer();
      if (bytes.byteLength > GMI_MAX_IMAGE_BYTES) throw new Error(`gmicloud: image too large (${bytes.byteLength} bytes)`);
      return { state: "done", image: { bytes, mime } };
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${GMI_QUEUE}/requests`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(GMI_VALIDATE_TIMEOUT_MS),
      });
      return res.ok;
    },
  };
}
```

Update `providerFor` to drop the `sleep` parameter:

```ts
export function providerFor(name: string, fetchFn: typeof fetch = fetch): ImageProvider {
  if (name === "openai") return makeOpenAiProvider(fetchFn);
  if (name === "gmicloud") return makeGmiProvider(fetchFn);
  throw new Error(`unknown provider ${name}`);
}
```

- [ ] **Step 4: Keep byok.ts compiling (narrow, temporary)**

`src/byok.ts` still calls `provider.generate(...)` (it dies in Task 6). At its call site (line ~77-78), narrow the union:

```ts
    const provider = (cfg.providerFor ?? ((n: string) => realProviderFor(n, cfg.fetchFn ?? fetch)))(row.provider);
    if (provider.mode !== "sync") throw new Error("async provider on the legacy sync path");
    img = await provider.generate(i.prompt, apiKey);
```

Fix any `byok.test.ts` fakes that stub `providerFor` to include `mode: "sync"`. `byok-routes.ts` only calls `validateKey` — both modes have it, no change.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS (new GMI tests green; OpenAI tests untouched; byok tests green with the mode tag).

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/providers.ts projects/worker/src/byok.ts projects/worker/test/providers.test.ts projects/worker/test/byok.test.ts
git commit -m "feat(providers): async/sync provider split — GMI decomposed to submit/check (one short connection per call)"
```

---

### Task 4: generation-jobs module (start / drive / publish / sync-run / sweep)

The heart of the feature. `src/generation-jobs.ts` replaces `tryByokGenerate`'s transport while preserving its load-bearing ordering: guardrails (fail-closed) → atomic reserve → job row → provider → durable persist → best-effort accounting. Terminal failure refunds exactly once (guarded by `GenerationStore.fail`'s return).

**Files:**
- Create: `projects/worker/src/generation-jobs.ts`
- Test: `projects/worker/test/generation-jobs.test.ts`

**Interfaces:**
- Consumes: `Services.generations` (Task 2), `AsyncImageProvider`/`SyncImageProvider`/`providerFor` (Task 3), `s.byok.*`, `s.assets.insertGenerated`, `s.embedder`, `s.vectorize`.
- Produces (exact exports consumed by Task 5 routes and Task 6 cleanup):

```ts
export interface GenBucket { put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; }
export interface GenJobsCfg {
  kek?: string; moderationKey?: string; bucket?: GenBucket; publicUrlBase?: string;
  now: () => number; fetchFn?: typeof fetch;
  providerFor?: (name: string) => ImageProvider; uuid?: () => string;
  waitUntil?: (p: Promise<unknown>) => void;   // ctx.waitUntil in the worker; tests omit it (sync jobs run inline)
}
export function monthKey(nowSec: number): string;
export type StartOutcome =
  | { kind: "accepted"; row: GenerationRow; used: number; cap: number; estSpendUsd: number }
  | { kind: "content_policy"; category: string }
  | { kind: "cap_reached"; used: number; cap: number }
  | { kind: "byok_unconfigured" }
  | { kind: "provider_error" };
export function startGeneration(i: { userId: string; collectionId: string; prompt: string }, s: Services, cfg: GenJobsCfg): Promise<StartOutcome>;
export function driveGeneration(genId: string, s: Services, cfg: GenJobsCfg): Promise<GenerationRow | null>;
export function sweepGenerations(s: Services, cfg: GenJobsCfg): Promise<void>;
export const SWEEP_STALE_SEC: number;   // 120
export const SWEEP_ABANDON_SEC: number; // 900
```

- [ ] **Step 1: Write the failing tests**

`projects/worker/test/generation-jobs.test.ts`. Reuse the setup patterns from `test/byok.test.ts` (it already fakes `providerFor`, KEK encryption via `encryptSecret`, moderation via `fetchFn` stubs — copy its helpers). Cover, as real implemented tests:

```ts
// --- startGeneration gates (mirror byok.test.ts coverage on the new module) ---
// 1. no kek/bucket/publicUrlBase            -> { kind: "byok_unconfigured" }
// 2. no byok row / disabled row             -> { kind: "byok_unconfigured" }
// 3. denylisted prompt                      -> { kind: "content_policy", category: "denylist:..." } and NO reserve
// 4. moderation flags                       -> { kind: "content_policy" }, NO reserve
// 5. moderation endpoint down               -> { kind: "provider_error" }, NO reserve (fail closed)
// 6. cap spent                              -> { kind: "cap_reached", used, cap }
// 7. decrypt failure                        -> provider_error + byok.disable("decrypt_failed")
// --- async provider (gmicloud row) ---
// 8. happy path: job row created (status generating, provider_job_id set),
//    outcome accepted with used/cap, reservation held (usage count 1)
// 9. submit throws                          -> job failed, reservation refunded (count back to 0), provider_error
// 10. submit throws ProviderAuthError       -> also byok.disable("provider_auth_failed")
// --- sync provider (openai row, cfg.waitUntil omitted so it runs inline) ---
// 11. happy path: generate() called once; asset row inserted with
//     collectionId + createdBy; R2 bucket.put called with byok/<assetId>/original.webp;
//     job row succeeded with asset_id; addSpend recorded; vectorize.upsert AND
//     upsertNamespace(collection) called
// 12. generate() throws                     -> job failed + refunded
// --- driveGeneration (async job in 'generating') ---
// 13. check pending  -> row still generating, claim released (a second drive succeeds)
// 14. check done     -> published exactly like (11); second driveGeneration returns succeeded row without provider calls
// 15. check failed   -> job failed + refunded once (drive again: no second refund)
// 16. check throws (network) -> claim released, job still open, NO refund
// 17. check throws ProviderAuthError -> failed + refunded + key disabled
// 18. concurrent drive: first claim wins; with the claim held, driveGeneration returns the row WITHOUT calling check
// --- sweepGenerations ---
// 19. open job younger than SWEEP_ABANDON_SEC with provider_job_id -> gets driven (check called)
// 20. open job older than SWEEP_ABANDON_SEC -> failed + refunded ("abandoned")
//     (set created_at on the fake row to an old datetime string)
// 21. sync job (no provider_job_id), younger than abandon window -> untouched
```

Implement every numbered case as a real test with real asserts — the comment block above is the coverage checklist, not the test body. Use `fakeServices()` + a `cfg` with a stub `providerFor` returning hand-built async/sync providers whose `submit/check/generate` push into arrays you assert on.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/generation-jobs.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/generation-jobs.ts`**

```ts
import type { Services, GenerationRow } from "./types";
import { decryptSecret } from "./crypto";
import { deniedTerm } from "./denylist";
import { moderationFlagged } from "./moderation";
import {
  providerFor as realProviderFor, ProviderAuthError,
  type ImageProvider, type SyncImageProvider, type GeneratedImage,
} from "./providers";
import contract from "../../../contract.json";

export interface GenBucket { put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; }
export interface GenJobsCfg {
  kek?: string;
  moderationKey?: string;
  bucket?: GenBucket;
  publicUrlBase?: string;
  now: () => number;
  fetchFn?: typeof fetch;
  providerFor?: (name: string) => ImageProvider;
  uuid?: () => string;
  /** ctx.waitUntil in the worker; tests omit it so sync jobs run inline. */
  waitUntil?: (p: Promise<unknown>) => void;
}

export function monthKey(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 7);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp" };
/** Sweep: open jobs untouched this long get re-driven. */
export const SWEEP_STALE_SEC = 120;
/** Sweep: jobs this old are failed+refunded. Past OpenAI's ~10-min background
 *  retention nothing is recoverable, and a lost sync waitUntil can't resume. */
export const SWEEP_ABANDON_SEC = 900;
const SWEEP_BATCH = 20;

export type StartOutcome =
  | { kind: "accepted"; row: GenerationRow; used: number; cap: number; estSpendUsd: number }
  | { kind: "content_policy"; category: string }
  | { kind: "cap_reached"; used: number; cap: number }
  | { kind: "byok_unconfigured" }
  | { kind: "provider_error" };

function providerOf(cfg: GenJobsCfg, name: string): ImageProvider {
  return (cfg.providerFor ?? ((n: string) => realProviderFor(n, cfg.fetchFn ?? fetch)))(name);
}

/** Terminal failure exactly once: only the transitioning caller refunds. */
async function terminalFail(s: Services, gen: { id: string; user_id: string; month: string }, msg: string): Promise<void> {
  if (await s.generations.fail(gen.id, msg)) {
    try { await s.byok.refund(gen.user_id, gen.month); } catch (e) { console.error("gen refund failed", e); }
  }
}

// The async-generation start path. Ordering is load-bearing (inherited from
// tryByokGenerate): guardrails (fail-closed) -> atomic quota reserve -> job
// row -> provider submit. Failures after the reserve refund it (and an auth
// failure also disables the key). Nothing here waits for the image: async
// providers return after submit; sync providers run the whole job in
// waitUntil so the 202 returns immediately.
export async function startGeneration(
  i: { userId: string; collectionId: string; prompt: string }, s: Services, cfg: GenJobsCfg
): Promise<StartOutcome> {
  if (!cfg.kek || !cfg.bucket || !cfg.publicUrlBase) return { kind: "byok_unconfigured" };
  const row = await s.byok.get(i.userId);
  if (!row || !row.enabled) return { kind: "byok_unconfigured" };
  const pinned = (contract as any).byok_providers[row.provider];
  if (!pinned) return { kind: "byok_unconfigured" };

  const term = deniedTerm(i.prompt);
  if (term) return { kind: "content_policy", category: `denylist:${term}` };

  let apiKey: string;
  try { apiKey = await decryptSecret(row.key_ciphertext, cfg.kek); }
  catch (e) {
    console.error("byok decrypt failed", e);
    try { await s.byok.disable(i.userId, "decrypt_failed"); } catch (de) { console.error("byok disable failed", de); }
    return { kind: "provider_error" };
  }

  // openai users are moderated with their own key (the endpoint is free);
  // gmicloud users need the operator OPENAI_API_KEY. No key => never generate.
  const modKey = row.provider === "openai" ? apiKey : cfg.moderationKey;
  if (!modKey) return { kind: "byok_unconfigured" };
  let category: string | null;
  try { category = await moderationFlagged(i.prompt, modKey, cfg.fetchFn ?? fetch); }
  catch (e) { console.error("byok moderation unavailable", e); return { kind: "provider_error" }; }
  if (category) return { kind: "content_policy", category };

  const month = monthKey(cfg.now());
  if (!(await s.byok.reserve(i.userId, month, row.monthly_cap))) {
    let used = row.monthly_cap;
    try { used = (await s.byok.getUsage(i.userId, month)).count; } catch (e) { console.error("byok usage read failed", e); }
    return { kind: "cap_reached", used, cap: row.monthly_cap };
  }

  const id = `gen_${(cfg.uuid ?? (() => crypto.randomUUID()))()}`;
  try {
    await s.generations.create({ id, userId: i.userId, collectionId: i.collectionId, prompt: i.prompt, provider: row.provider, month });
  } catch (e) {
    console.error("gen row create failed", e);
    try { await s.byok.refund(i.userId, month); } catch (re) { console.error("gen refund failed", re); }
    return { kind: "provider_error" };
  }

  const provider = providerOf(cfg, row.provider);
  if (provider.mode === "async") {
    try {
      const jobId = await provider.submit(i.prompt, apiKey);
      await s.generations.setProviderJob(id, jobId);
    } catch (e) {
      console.error("gen submit failed", e);
      await terminalFail(s, { id, user_id: i.userId, month }, "provider submit failed");
      if (e instanceof ProviderAuthError) {
        try { await s.byok.disable(i.userId, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
      }
      return { kind: "provider_error" };
    }
  } else {
    // Sync provider (openai gpt-image-1, 13-20s: ducks the ~20s idle-kill).
    // The whole job runs after the 202; the ticket GET only reads D1 for it.
    const run = runSyncJob(id, i.userId, month, i.prompt, provider, apiKey, s, cfg)
      .catch((e) => console.error("sync generation job crashed", e));
    if (cfg.waitUntil) cfg.waitUntil(run); else await run;
  }

  const fresh = await s.generations.get(id);
  let used = 1;
  let estSpendUsd = pinned.price_per_image_usd;
  try {
    const usage = await s.byok.getUsage(i.userId, month);
    used = usage.count;
    estSpendUsd = usage.est_spend_usd;
  } catch (e) { console.error("byok usage read failed", e); }
  return { kind: "accepted", row: fresh!, used, cap: row.monthly_cap, estSpendUsd };
}

async function runSyncJob(
  genId: string, userId: string, month: string, prompt: string,
  provider: SyncImageProvider, apiKey: string, s: Services, cfg: GenJobsCfg
): Promise<void> {
  // Claim so the sweep can't race a live sync run; updated_at refresh also
  // keeps the row out of listStale while we work.
  if (!(await s.generations.claim(genId))) return;
  try {
    const img = await provider.generate(prompt, apiKey);
    await publish(genId, s, cfg, img);
  } catch (e) {
    console.error("sync generation failed", e);
    await terminalFail(s, { id: genId, user_id: userId, month }, "generation failed");
    if (e instanceof ProviderAuthError) {
      try { await s.byok.disable(userId, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
    }
  }
}

// Durable persist + accounting. Deterministic asset id (the gen id's uuid
// part) makes retries idempotent: R2 re-puts the same key, the D1 insert is
// skipped when the row exists, and the guarded succeed() transitions once.
// Vector writes stay best-effort — spec'd as namespace-ONLY: user creations
// live in their collection, never in the shared library (decision 2).
async function publish(genId: string, s: Services, cfg: GenJobsCfg, img: GeneratedImage): Promise<void> {
  const row = await s.generations.get(genId);
  if (!row || (row.status !== "queued" && row.status !== "generating")) return;
  const pinned = (contract as any).byok_providers[row.provider];
  const assetId = row.id.startsWith("gen_") ? row.id.slice(4) : `${row.id}-a`;
  const key = `byok/${assetId}/original.${EXT[img.mime] ?? "png"}`;
  await cfg.bucket!.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
  const sourceUrl = `${cfg.publicUrlBase!.replace(/\/+$/, "")}/${key}`;
  if (!(await s.assets.getAsset(assetId))) {
    await s.assets.insertGenerated({
      id: assetId, prompt: row.prompt, sourceUrl, mime: img.mime,
      width: 1024, height: 1024, // requested size; providers may letterbox but 1024x1024 is what we ask for
      modelUsed: pinned.model, provider: row.provider, priceUsd: pinned.price_per_image_usd,
      createdBy: row.user_id, collectionId: row.collection_id,
    });
  }
  const transitioned = await s.generations.succeed(row.id, assetId);
  // Durable + paid past this point: best-effort bookkeeping only.
  if (transitioned) {
    try { await s.byok.addSpend(row.user_id, row.month, pinned.price_per_image_usd); } catch (e) { console.error("gen addSpend failed", e); }
  }
  try {
    const vec = await s.embedder.textEmbed(row.prompt);
    try { await s.vectorize.upsertNamespace(assetId, vec, row.collection_id); } catch (e) { console.error("gen namespace upsert failed", e); }
  } catch (e) { console.error("gen embed failed", e); }
}

// Poll-through drive: one short provider status check per call, under the
// atomic claim. Transient errors release the claim (next poll/sweep retries);
// auth errors are terminal. Sync jobs (no provider_job_id) are owned by their
// waitUntil — there is nothing to drive here.
export async function driveGeneration(genId: string, s: Services, cfg: GenJobsCfg): Promise<GenerationRow | null> {
  const row = await s.generations.get(genId);
  if (!row) return null;
  if (row.status !== "queued" && row.status !== "generating") return row;
  if (!row.provider_job_id) return row;
  if (!(await s.generations.claim(genId))) return row;
  try {
    const keyRow = await s.byok.get(row.user_id);
    if (!keyRow) { await terminalFail(s, row, "provider key removed"); return await s.generations.get(genId); }
    // NOTE: a disabled key still polls — the job is already paid for; only a
    // provider auth failure below is terminal.
    let apiKey: string;
    try { apiKey = await decryptSecret(keyRow.key_ciphertext, cfg.kek!); }
    catch { await terminalFail(s, row, "key decrypt failed"); return await s.generations.get(genId); }
    const provider = providerOf(cfg, row.provider);
    if (provider.mode !== "async") { await s.generations.release(genId); return row; }
    const st = await provider.check(row.provider_job_id, apiKey);
    if (st.state === "pending") { await s.generations.release(genId); return await s.generations.get(genId); }
    if (st.state === "failed") { await terminalFail(s, row, st.error); return await s.generations.get(genId); }
    await publish(genId, s, cfg, st.image);
    return await s.generations.get(genId);
  } catch (e) {
    console.error("gen drive failed", e);
    if (e instanceof ProviderAuthError) {
      await terminalFail(s, row, "provider auth failed");
      try { await s.byok.disable(row.user_id, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
    } else {
      try { await s.generations.release(genId); } catch (re) { console.error("gen release failed", re); }
    }
    return await s.generations.get(genId);
  }
}

function epochSec(d1Datetime: string): number {
  return Math.floor(Date.parse(d1Datetime.replace(" ", "T") + "Z") / 1000);
}

// Cron backstop: finishes what nobody polled to completion. Rows a live
// driver is working on have a fresh updated_at (claim refreshes it), so
// listStale never hands us a job mid-drive.
export async function sweepGenerations(s: Services, cfg: GenJobsCfg): Promise<void> {
  const stale = await s.generations.listStale(SWEEP_STALE_SEC, SWEEP_BATCH);
  for (const row of stale) {
    try {
      if (cfg.now() - epochSec(row.created_at) > SWEEP_ABANDON_SEC) {
        await terminalFail(s, row, "abandoned: no completion within the retention window");
      } else if (row.provider_job_id) {
        await driveGeneration(row.id, s, cfg);
      }
      // Sync jobs without a provider_job_id can't be resumed (their waitUntil
      // died with the request) — only the age check above ever finishes them.
    } catch (e) { console.error("sweep item failed", e); }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/generation-jobs.test.ts`
Expected: PASS (all ~21 cases).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/generation-jobs.ts projects/worker/test/generation-jobs.test.ts
git commit -m "feat(gen): generation-jobs module — start/drive/publish/sweep with once-only refunds"
```

---

### Task 5: Routes, index wiring, cron sweep

**Files:**
- Create: `projects/worker/src/generations-routes.ts`
- Modify: `projects/worker/src/index.ts` (fetch signature gains `ctx`, two routes, `genJobsCfg` helper, `scheduled` export)
- Modify: `projects/worker/wrangler.toml` (cron trigger)
- Test: `projects/worker/test/generations-routes.test.ts`

**Interfaces:**
- Consumes: `startGeneration`/`driveGeneration`/`GenJobsCfg` (Task 4), `resolveApiPrincipal` (session.ts), `combinedPrompt` (collections.ts), `MAX_PROMPT_LEN` (handler.ts), `assetUrls` (asset-urls.ts).
- Produces:
  - `POST /v1/collections/:id/generations` → `202 {generation, byok:{used,cap,est_spend_usd}}` | `401` | `404 unknown collection` (non-owner: same capability semantics as collections-routes) | `429 Too many requests` (limiter) | `400 invalid JSON` | `422 prompt` | `400 content_policy` | `429 monthly cap reached` | `403 byok required` | `502 generation failed to start`
  - `GET /v1/generations/:id` → `200 {generation}` | `401` | `404 not found` (missing or not owner)
  - `generation` view: `{ id, status, collection, prompt, created_at, error?, image?: {id, url, thumb_url, medium_url, original_url} }`

- [ ] **Step 1: Write failing route tests**

`projects/worker/test/generations-routes.test.ts` — follow the request-building + `fakeServices` style of `test/collections-routes.test.ts` (session/dev auth setup, JSON bodies). Cover, fully implemented:

```ts
// POST /v1/collections/:id/generations (call handleCreateGeneration directly)
// 1. unauthenticated -> 401
// 2. unknown collection id -> 404 {error:"unknown collection"}
// 3. someone else's collection -> 404 (not 403 — ownership undisclosed)
// 4. prompt missing/empty -> 422
// 5. combined prompt (user + theme) over MAX_PROMPT_LEN -> 422 mentioning "collection theme"
// 6. no byok key -> 403 {error:"byok required"}
// 7. happy path (gmicloud fake async provider) -> 202, body.generation.status === "generating",
//    body.generation.collection === collection id, body.byok.used === 1
// 8. cap spent -> 429 {error:"monthly cap reached"}
// 9. denylisted prompt -> 400 {error:"content_policy"}
// GET /v1/generations/:id (handleGetGeneration)
// 10. unauthenticated -> 401
// 11. someone else's generation -> 404
// 12. pending job + fake provider check=pending -> 200 status "generating", no image
// 13. fake provider check=done -> 200 status "succeeded" with image.url/thumb_url populated
// 14. failed job -> 200 status "failed" with error string
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/generations-routes.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/generations-routes.ts`**

```ts
import type { Env, Services, GenerationRow, AssetRow } from "./types";
import { resolveApiPrincipal } from "./session";
import { combinedPrompt } from "./collections";
import { MAX_PROMPT_LEN } from "./handler";
import { startGeneration, driveGeneration, type GenJobsCfg } from "./generation-jobs";
import { assetUrls } from "./asset-urls";

// Creation surface: session or bearer key, owner-only. Non-owner requests on
// a collection answer 404 (not 403) — the id is a capability for *searching*;
// whether someone else owns it is not disclosed (same as collections-routes).

export function generationView(row: GenerationRow, asset: AssetRow | null, assetBaseUrl?: string) {
  const view: Record<string, unknown> = {
    id: row.id, status: row.status, collection: row.collection_id,
    prompt: row.prompt, created_at: row.created_at,
  };
  if (row.status === "failed" && row.error) view.error = row.error;
  if (row.status === "succeeded" && asset) {
    const u = assetUrls(asset, assetBaseUrl);
    view.image = { id: asset.id, url: u.url, thumb_url: u.thumb_url, medium_url: u.medium_url, original_url: u.original_url };
  }
  return view;
}

export async function handleCreateGeneration(
  collectionId: string, request: Request, env: Env, s: Services, cfg: GenJobsCfg, assetBaseUrl?: string
): Promise<Response> {
  const p = await resolveApiPrincipal(request, env, s);
  if (!p) return Response.json({ error: "login required" }, { status: 401 });
  const coll = await s.collections.get(collectionId);
  if (!coll || coll.owner_user_id !== p.userId) return Response.json({ error: "unknown collection" }, { status: 404 });
  if (!(await s.rateLimiter.limit(`bgen:${p.userId}`))) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (typeof body?.prompt !== "string" || body.prompt.trim() === "") {
    return Response.json({ error: "prompt required" }, { status: 422 });
  }
  if (body.prompt.length > MAX_PROMPT_LEN) {
    return Response.json({ error: `prompt must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
  }
  const prompt = combinedPrompt(body.prompt, coll.theme_prompt);
  if (prompt.length > MAX_PROMPT_LEN) {
    return Response.json({ error: `prompt plus collection theme must be at most ${MAX_PROMPT_LEN} characters` }, { status: 422 });
  }
  const out = await startGeneration({ userId: p.userId, collectionId: coll.id, prompt }, s, cfg);
  switch (out.kind) {
    case "accepted":
      return Response.json(
        { generation: generationView(out.row, null, assetBaseUrl), byok: { used: out.used, cap: out.cap, est_spend_usd: out.estSpendUsd } },
        { status: 202 }
      );
    case "content_policy":
      return Response.json({ error: "content_policy", category: out.category }, { status: 400 });
    case "cap_reached":
      return Response.json({ error: "monthly cap reached", used: out.used, cap: out.cap }, { status: 429 });
    case "byok_unconfigured":
      return Response.json({ error: "byok required", detail: "add an enabled provider key first" }, { status: 403 });
    case "provider_error":
      return Response.json({ error: "generation failed to start" }, { status: 502 });
  }
}

export async function handleGetGeneration(
  id: string, request: Request, env: Env, s: Services, cfg: GenJobsCfg, assetBaseUrl?: string
): Promise<Response> {
  const p = await resolveApiPrincipal(request, env, s);
  if (!p) return Response.json({ error: "login required" }, { status: 401 });
  let row = await s.generations.get(id);
  if (!row || row.user_id !== p.userId) return Response.json({ error: "not found" }, { status: 404 });
  if (row.status === "queued" || row.status === "generating") {
    row = (await driveGeneration(id, s, cfg)) ?? row;
  }
  const asset = row.status === "succeeded" && row.asset_id ? await s.assets.getAsset(row.asset_id) : null;
  return Response.json({ generation: generationView(row, asset, assetBaseUrl) });
}
```

- [ ] **Step 4: Wire index.ts**

In `projects/worker/src/index.ts`:

1. Change the fetch signature (line 83) to `async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {`.
2. Add imports: `import { handleCreateGeneration, handleGetGeneration } from "./generations-routes";` and `import { sweepGenerations, type GenJobsCfg } from "./generation-jobs";` (the `ByokCfg` import from `./byok` stays until Task 6).
3. Add a module-level helper above `export default`:

```ts
function genJobsCfg(env: Env, waitUntil?: (p: Promise<unknown>) => void): GenJobsCfg {
  return {
    kek: env.BYOK_KEK, moderationKey: env.OPENAI_API_KEY,
    bucket: env.BYOK_ORIGINALS, publicUrlBase: env.BYOK_PUBLIC_URL_BASE,
    now: () => Math.floor(Date.now() / 1000),
    waitUntil,
  };
}
```

4. Add the routes directly BEFORE the `collImages` matcher (line ~137) — the `/generations$` suffix means no regex collision, but keep creation next to its collection siblings:

```ts
      const genCreate = url.pathname.match(/^\/v1\/collections\/([^/]+)\/generations$/);
      if (genCreate && request.method === "POST") {
        let id: string;
        try { id = decodeURIComponent(genCreate[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleCreateGeneration(id, request, env, services, genJobsCfg(env, (p) => ctx.waitUntil(p)), env.ASSET_BASE_URL);
      }
      const genGet = url.pathname.match(/^\/v1\/generations\/([^/]+)$/);
      if (genGet && request.method === "GET") {
        let id: string;
        try { id = decodeURIComponent(genGet[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleGetGeneration(id, request, env, services, genJobsCfg(env, (p) => ctx.waitUntil(p)), env.ASSET_BASE_URL);
      }
```

5. Add the scheduled handler to the default export, after `fetch`:

```ts
  // Cron backstop for async generation jobs nobody polled to completion:
  // re-drives recoverable ones, fails+refunds abandoned ones.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const services = buildServices(env);
    ctx.waitUntil(sweepGenerations(services, genJobsCfg(env, (p) => ctx.waitUntil(p))));
  },
```

6. In `projects/worker/wrangler.toml`, after the `[assets]` block:

```toml
# Cron sweep for async BYOK generation jobs (generation-jobs.ts): every 2 min
# so an abandoned OpenAI background job is still inside its ~10-min retention.
[triggers]
crons = ["*/2 * * * *"]
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/generations-routes.test.ts && npm test`
Expected: PASS. If `test/router.test.ts` constructs the worker's fetch with two args, update those call sites to pass a stub ctx: `{ waitUntil: () => {} } as any`.

- [ ] **Step 6: Commit**

```bash
git add projects/worker/src/generations-routes.ts projects/worker/src/index.ts projects/worker/wrangler.toml projects/worker/test/generations-routes.test.ts projects/worker/test/router.test.ts
git commit -m "feat(api): POST /v1/collections/:id/generations (202+ticket) + GET /v1/generations/:id (poll-through) + cron sweep"
```

---

### Task 6: Read-path simplification (kill the sync BYOK path)

`POST /v1/images/generations` becomes a pure closest-match lookup: `cache_tolerance`/`generate_on_miss` removed outright (pre-launch, no shim; unknown JSON fields are simply ignored), tolerance pinned at the server default, all BYOK plumbing deleted. Per spec decision 2, user creations are collection-only — the global LIKE search additionally excludes collection assets so the shared library surface stays operator-curated.

**Files:**
- Modify: `projects/worker/src/handler.ts`
- Modify: `projects/worker/src/index.ts` (drop byokCtx from the route; drop the `ByokCfg` import)
- Modify: `projects/worker/src/d1.ts` (`searchAssets` unscoped filter)
- Modify: `projects/worker/src/byok-routes.ts:5` (`monthKey` import moves to `./generation-jobs`)
- Delete: `projects/worker/src/byok.ts`, `projects/worker/test/byok.test.ts`
- Test: `projects/worker/test/handler.test.ts` (rewrite affected cases), `projects/worker/test/byok-d1.test.ts` (adjust one assertion), `projects/worker/test/d1-real-schema.test.ts` (extend)

**Interfaces:**
- Produces: `GenBody = { prompt: string; n?: number; size?: string; collection?: string }`; `handleGenerate(body, s, cfg)` (the `byok` parameter is GONE). Response shape unchanged except: `byok` field never appears; `generation_queued` reflects the demand queue only.

- [ ] **Step 1: Write/adjust failing tests first**

In `test/handler.test.ts`:
- DELETE every test that passes `cache_tolerance`, `generate_on_miss`, or a `byok` argument / asserts on `shared_cache.byok` or in-request generation.
- ADD:

```ts
// 1. body with cache_tolerance/generate_on_miss present -> fields are ignored:
//    same response as without them (200 approximate, no 422)
// 2. below-floor best match -> 200 result "approximate" with similarity + image url,
//    recordQuery called with generate: true
// 3. empty pool -> 202 result "pending", generation_queued true (unscoped)
// 4. scoped (collection param) empty pool -> 202 with generation_queued false and
//    NO recordQuery call (backfill exclusion unchanged)
// 5. handleGenerate signature takes no byok arg (compile-level; just call it with 3 args everywhere)
```

In `test/d1-real-schema.test.ts` ADD:

```ts
it("unscoped searchAssets excludes collection assets (shared library is operator-curated)", async () => {
  const db = realDb();
  seedUser(db);
  const { assets, collections } = makeD1Stores(db);
  await collections.create({ id: "col_x", ownerUserId: "usr_1", name: "n", themePrompt: "" });
  await assets.insertGenerated({ id: "pub1", prompt: "green fox", sourceUrl: "https://x/1.webp", mime: "image/webp", width: 1024, height: 1024, modelUsed: "m", provider: "openai", priceUsd: 0.04, createdBy: "usr_1", collectionId: null });
  await assets.insertGenerated({ id: "col1", prompt: "green fox scoped", sourceUrl: "https://x/2.webp", mime: "image/webp", width: 1024, height: 1024, modelUsed: "m", provider: "openai", priceUsd: 0.04, createdBy: "usr_1", collectionId: "col_x" });
  const unscoped = await assets.searchAssets({ q: "green fox", limit: 10, offset: 0 });
  expect(unscoped.map((r) => r.id)).toEqual(["pub1"]);
  const scoped = await assets.searchAssets({ q: "green fox", limit: 10, offset: 0, collectionId: "col_x" });
  expect(scoped.map((r) => r.id)).toEqual(["col1"]);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/handler.test.ts test/d1-real-schema.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Simplify handler.ts**

- Remove the import of `tryByokGenerate`/`ByokCfg`/`ByokOutcome`; delete `runByok` (lines 20–42) and `generatedResponse` (lines 44–67) entirely.
- `GenBody` becomes `{ prompt: string; n?: number; size?: string; collection?: string }`.
- `handleGenerate` signature: `(body: GenBody, s: Services, cfg: GenCfg)` — drop the `byok` param.
- Delete the `generate_on_miss` and `cache_tolerance` validation blocks (lines 76–78, 85–89). Unknown fields in the body are ignored (never 422 on them).
- Replace `const tol = body.cache_tolerance ?? DEFAULT_CACHE_TOLERANCE; const generateOnMiss = body.generate_on_miss ?? true;` with `const floor = similarityFloor(DEFAULT_CACHE_TOLERANCE, cfg.floorSimMax, cfg.floorSimMin);` and delete the `gen` ownership-guard line (107–109).
- Empty-pool branch: delete the `runByok` call and both `outcome` branches; keep the `recordQuery` (unscoped) with `generate: true` and the `202 pending` response, minus the `byok` field.
- Below-floor branch: delete the `runByok` call and branches; keep `recordQuery` with `generate: true`; response loses the `byok` field. The `generation_queued`/`cost_saved_usd`/`result`/`similarity` semantics stay exactly as they are.

- [ ] **Step 4: Unwire index.ts and move monthKey**

- `index.ts`: in the `/v1/images/generations` route, delete the whole `byokCtx` construction (lines 211–222) and call `handleGenerate(body, services, cfg)`. Delete the `import type { ByokCfg } from "./byok"` line.
- `byok-routes.ts:5`: change `import { monthKey } from "./byok";` to `import { monthKey } from "./generation-jobs";`.
- Delete `src/byok.ts` and `test/byok.test.ts` (`git rm`). Run `grep -rn "from \"./byok\"" projects/worker/src projects/worker/test` — expect zero hits.

- [ ] **Step 5: Filter collection assets out of unscoped search**

In `d1.ts` `searchAssets` (line ~27), the unscoped path gains a `collection_id IS NULL` condition:

```ts
    async searchAssets({ q, limit, offset, collectionId }) {
      const tokens = q.split(/\s+/).filter(Boolean);
      const where: string[] = tokens.map(() => "prompt LIKE ? ESCAPE '\\'");
      const args: unknown[] = tokens.map((t) => `%${escapeLike(t)}%`);
      // Scoped search sees the collection; unscoped search must never surface
      // collection assets — the shared library is operator-curated (spec
      // 2026-07-10, decision 2).
      if (collectionId) { where.push("collection_id = ?"); args.push(collectionId); }
      else { where.push("collection_id IS NULL"); }
      const cond = where.length ? `WHERE ${where.join(" AND ")} ` : "";
      ...
```

In `test/byok-d1.test.ts`, the "asset read paths never select collection_id or serve_count" test now over-matches (`collection_id` appears in the WHERE). Update it: keep the assertion for `getAsset` and `getAssetsByIds`; for `searchAssets` assert `c.sql` does not contain `collection_id` in the SELECT list — e.g. `expect(c.sql.slice(0, c.sql.indexOf("FROM"))).not.toContain("collection_id")` — and extend the comment accordingly.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, with byok.test.ts gone and handler tests green.

- [ ] **Step 7: Commit**

```bash
git add -A projects/worker/src projects/worker/test
git commit -m "feat(api)!: read endpoint is pure closest-match — cache_tolerance/generate_on_miss removed, BYOK sync path deleted, shared library excludes collection assets"
```

---

### Task 7: SPA — merged Library|Collections page (shell, moves, redirects)

Line numbers below are pre-edit anchors in `projects/worker/public/index.html` — verify each with a quick search before cutting, then work top-to-bottom so earlier edits don't shift later anchors you haven't visited.

**Files:**
- Modify: `projects/worker/public/index.html`

**Interfaces:**
- Produces: `showLibTab(tab: 'library'|'collections')` global; `#tab-library` / `#tab-collections` panels inside `view-library`; `#/playground` → `#/library` redirect. Existing functions `renderByok()`, `loadCollections()`, `renderCollections()` keep their names and element ids (`byok-body`, `collections-body`) — they just live in the new panel.

- [ ] **Step 1: Add the tab CSS**

Next to `.library-bar` (~line 411), add:

```css
    .page-tabs { display: inline-flex; gap: 4px; margin: 0 0 18px; padding: 4px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); }
    .page-tab { border: none; background: transparent; padding: 8px 18px; border-radius: 999px; font: inherit; font-weight: 600; font-size: 0.9rem; color: var(--ink-soft); cursor: pointer; }
    .page-tab:hover { color: var(--ink); }
    .page-tab.active { background: var(--ink); color: #fff; }
```

- [ ] **Step 2: Restructure the `view-library` markup (~3077-3095)**

Directly under the existing `.page-head`, insert the tab bar; wrap the existing library controls in a panel; add the collections panel:

```html
        <div class="page-tabs" role="tablist">
          <button class="page-tab active" data-tab="library" onclick="showLibTab('library')">Library</button>
          <button class="page-tab" data-tab="collections" onclick="showLibTab('collections')">My collections</button>
        </div>
        <div id="tab-library">
          <!-- existing .library-bar, #library-grid, #library-status, #library-more move in here unchanged -->
        </div>
        <div id="tab-collections" hidden>
          <!-- Step 3 moves the account BYOK + collections cards here; Task 8 adds the generate card above them -->
        </div>
```

- [ ] **Step 3: Move the BYOK and collections cards out of `view-account`**

Cut the BYOK card (lines 3140–3147, the `.glass-card` containing `id="byok-body"` and the estimate-disclaimer paragraph) and the collections card (3149–3156, containing `id="collections-body"`) and paste both inside `#tab-collections`. The bearer API-keys card (3158–3178), telemetry, plan, and reset cards STAY on account. The `key-modal` markup stays where it is (it belongs to bearer keys).

- [ ] **Step 4: Add the tab switcher + rewire routes**

In the script, near the library JS (~4292), add:

```js
    let activeLibTab = 'library';
    function showLibTab(tab) {
      activeLibTab = tab;
      document.getElementById('tab-library').hidden = tab !== 'library';
      document.getElementById('tab-collections').hidden = tab !== 'collections';
      document.querySelectorAll('.page-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'collections') { renderByok(); loadCollections(); }
    }
```

Route table edits (~3933-3968):
- `#/library` entry becomes `onShow: () => { initLibrary(); if (activeLibTab === 'collections') { renderByok(); loadCollections(); } }`.
- DELETE the `#/playground` entry. In `showRoute` (~3998), next to the existing `#/clip` legacy redirect, add: `if (route === '#/playground') { location.replace('#/library'); return; }`.
- `PATH_TO_HASH` (~3970): `'/playground': '#/library'`.
- `GATED` (~3991): remove `'#/playground'`.
- Account `onShow` (~3938-3952): remove the `renderByok()` and `loadCollections()` calls (they belong to the collections tab now); keep `updateStats(); loadKeys(); renderPlan();` and the checkout toast.

- [ ] **Step 5: Delete the playground view + its dead JS, update nav**

- Delete the `view-playground` markup block (2942–3074) entirely.
- Delete these functions: `applyPreset` (4207-4210), `updateToleranceValue` (4212-4226), `updateGenGating` (4725-4745), `loadPlaygroundCollections` (4703-4720), `generateImage` (4850-5041), `appendResultNote` (4840-4848). (Task 8 rebuilds generation UI fresh; committing this task with creation UI absent is fine — tasks land together on main before deploy.)
- Nav/link sweep: delete the Playground mega-dropdown item (2365-2368) and the footer Playground link (3833); repoint the hero/CTA links at 2466, 2778, 2860, 2888 from `#/playground` to `#/library`.
- Grep for leftovers: `grep -n "playground\|gen-on-miss\|tol-group\|updateGenGating\|applyPreset\|history-list\|coll-select\|loader-msg\|out-img\|viewport" projects/worker/public/index.html` — every remaining hit must be either intentional (docs prose) or removed. Check `resetSession()` (4808-4837) and `updateStats()` for references to deleted elements and strip them.

- [ ] **Step 6: Manual smoke**

Run: `cd projects/worker && npx wrangler dev --local` (see `.claude/skills/running-locally` — needs `.dev.vars` with `DEV_MODE=true`).
Verify in a browser: `#/library` shows tabs; Library tab searches; Collections tab renders the BYOK form + collections list; `#/playground` redirects to `#/library`; `#/account` still shows plan/keys/telemetry; no console errors on any of those pages.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(ui): merge playground+library into one Library|Collections page; BYOK key management moves to the Collections tab"
```

---

### Task 8: SPA — collection generate box with ticket polling

**Files:**
- Modify: `projects/worker/public/index.html`

**Interfaces:**
- Consumes: `POST /v1/collections/:id/generations` (202 `{generation:{id,status}, byok:{used,cap,est_spend_usd}}`), `GET /v1/generations/:id` (`{generation:{status, image?, error?}}`), globals `myCollections`, `currentByok`, helpers `escapeHtml`, `showToast`, `renderCollections`, `loadCollections`.

- [ ] **Step 1: Add the generate card markup**

At the TOP of `#tab-collections` (above the moved BYOK card), insert:

```html
          <div class="glass-card">
            <h3>Create an image</h3>
            <p class="muted">Generated with your own provider key, straight into one of your collections. <span id="gen-key-status"></span></p>
            <div class="form-group">
              <label class="field-label" for="gen-coll-select">Collection</label>
              <select id="gen-coll-select" class="field-input"></select>
            </div>
            <div class="form-group">
              <label class="field-label" for="gen-prompt">Prompt</label>
              <textarea id="gen-prompt" class="field-input" rows="3" placeholder="A watercolor fox in morning fog"></textarea>
            </div>
            <button id="btn-generate" onclick="createInCollection()">Generate</button>
            <div id="gen-result"></div>
          </div>
```

Copy the exact class list of the old playground submit button (it was `id="btn-submit"` — check git history `git show HEAD~1:projects/worker/public/index.html | grep -n 'btn-submit'` if unsure) onto `#btn-generate` so it matches the design system.

- [ ] **Step 2: Add the generation JS**

Near the collections JS (~4552), add:

```js
    const GEN_POLL_MS = 2500;
    const GEN_POLL_MAX_MS = 6 * 60 * 1000;
    let genBusy = false;

    function populateGenCollections() {
      const sel = document.getElementById('gen-coll-select');
      if (!sel) return;
      sel.innerHTML = myCollections.length
        ? myCollections.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
        : '<option value="">— create a collection below first —</option>';
    }

    function renderGenKeyStatus() {
      const el = document.getElementById('gen-key-status');
      if (!el) return;
      if (currentByok && currentByok.enabled) el.innerHTML = `<span class="muted">Using your ${escapeHtml(currentByok.provider)} key.</span>`;
      else el.innerHTML = '<strong>Add an enabled provider key below to generate.</strong>';
    }

    function setGenResult(html) { document.getElementById('gen-result').innerHTML = html; }

    function genLoaderHtml(startTime) {
      const secs = Math.round((performance.now() - startTime) / 1000);
      return `<p class="muted">Generating… ${secs}s. Long generations can take a minute or two; if it never lands, the reservation is refunded automatically.</p>`;
    }

    async function pollGeneration(genId, startTime) {
      while (performance.now() - startTime < GEN_POLL_MAX_MS) {
        await new Promise((r) => setTimeout(r, GEN_POLL_MS));
        let data = null;
        try {
          const r = await fetch(`/v1/generations/${encodeURIComponent(genId)}`, { credentials: 'same-origin' });
          if (r.status === 401) { location.hash = '#/login'; return null; }
          data = await r.json();
        } catch (e) { /* transient network error: keep polling */ }
        const gen = data && data.generation;
        if (gen && gen.status === 'succeeded') return gen;
        if (gen && gen.status === 'failed') throw new Error(gen.error || 'Generation failed');
        setGenResult(genLoaderHtml(startTime));
      }
      throw new Error('Timed out waiting for the image. If it never completes, the reservation is refunded automatically.');
    }

    async function createInCollection() {
      if (genBusy) return;
      const prompt = document.getElementById('gen-prompt').value.trim();
      const collId = document.getElementById('gen-coll-select').value;
      if (!prompt) { showToast('Enter a prompt first', 'error'); return; }
      if (!collId) { showToast('Create a collection first', 'error'); return; }
      genBusy = true;
      const btn = document.getElementById('btn-generate');
      btn.disabled = true;
      const startTime = performance.now();
      setGenResult(genLoaderHtml(startTime));
      try {
        const r = await fetch(`/v1/collections/${encodeURIComponent(collId)}/generations`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        if (r.status === 401) { location.hash = '#/login'; return; }
        const data = await r.json().catch(() => ({}));
        if (r.status === 400 && data.error === 'content_policy') throw new Error(`Blocked by content policy (${data.category || 'flagged'})`);
        if (r.status === 403) throw new Error('Add an enabled provider key first (below)');
        if (r.status === 429) throw new Error(data.error === 'monthly cap reached' ? `Monthly cap reached (${data.used}/${data.cap})` : 'Too many requests — slow down');
        if (!r.ok || !data.generation) throw new Error(data.error || `Error ${r.status}`);
        const done = await pollGeneration(data.generation.id, startTime);
        if (!done) return;
        const img = done.image || {};
        setGenResult(
          `<img src="${escapeHtml(img.medium_url || img.url || '')}" alt="${escapeHtml(prompt)}" style="max-width:100%;border-radius:12px;margin-top:12px;" />` +
          (data.byok ? `<p class="muted">${data.byok.used}/${data.byok.cap} this month · ~$${Number(data.byok.est_spend_usd).toFixed(2)} est. spend</p>` : '')
        );
        showToast('Image added to your collection', 'success');
        loadCollections(); // refresh counts + grids
      } catch (e) {
        setGenResult(`<p class="muted">⚠️ ${escapeHtml(e.message || String(e))}</p>`);
        showToast(e.message || 'Generation failed', 'error');
      } finally {
        genBusy = false;
        btn.disabled = false;
      }
    }
```

- [ ] **Step 3: Hook population into existing loaders**

At the end of `loadCollections()` (~4556-4571) add `populateGenCollections(); renderGenKeyStatus();`. At the end of `renderByok()`'s render (~4449-4492) add `renderGenKeyStatus();` (key changes update the hint). Verify `currentByok` is refreshed by `fetchMe()`/`saveByok` — if `saveByok` doesn't update `currentByok`, call `fetchMe()` after a successful save.

- [ ] **Step 4: Manual smoke (offline limits apply)**

Run: `npx wrangler dev --local`. Offline, generation 500s at the provider step (no local Vectorize/AI — see running-locally skill), so verify the failure UX: submit → loader with elapsed seconds → clean error + toast, button re-enabled, gates render (no key → 403 message). Full happy-path smoke happens on prod in Task 11.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(ui): async generate box in Collections tab — 202 ticket + poll with elapsed-time loader"
```

---

### Task 9: Docs page + DEPLOY.md

**Files:**
- Modify: `projects/worker/public/index.html` (docs + matching + openai/agents snippet sections)
- Modify: `DEPLOY.md`

- [ ] **Step 1: Update every API example in the SPA**

Run: `grep -n "cache_tolerance\|generate_on_miss\|extra_body" projects/worker/public/index.html`
For each hit inside the docs/openai/agents/home sections:
- Remove `cache_tolerance` / `generate_on_miss` from request examples and parameter tables; add one line to the docs prose: *"The API always returns the closest match with a `similarity` score — threshold client-side if you need stricter matching."*
- Where an example shows scoped search, use the `extra_body` form for the OpenAI-SDK snippet (handoff follow-up): `client.images.generate(prompt=..., extra_body={"collection": "col_..."})`.

- [ ] **Step 2: Document the new creation flow in the docs section**

Add a "Create images in your collections" docs block (same visual pattern as existing endpoint docs) with these exact examples:

```bash
# Start a generation (requires your own provider key + a collection you own)
curl -X POST https://api.wagmi.photos/v1/collections/col_abc123/generations \
  -H "Authorization: Bearer sc-..." -H "Content-Type: application/json" \
  -d '{"prompt": "a watercolor fox in morning fog"}'
# -> 202 {"generation": {"id": "gen_...", "status": "generating", ...}, "byok": {"used": 3, "cap": 50, ...}}

# Poll the ticket until it leaves queued/generating
curl https://api.wagmi.photos/v1/generations/gen_... -H "Authorization: Bearer sc-..."
# -> {"generation": {"status": "succeeded", "image": {"url": "...", "thumb_url": "..."}}}
```

Plus one sentence each on: statuses (`queued|generating|succeeded|failed`), automatic refund on terminal failure, and ownership (404 on collections you don't own).

- [ ] **Step 3: DEPLOY.md**

In the BYOK runbook section add: migration `0016` must be applied (`npx wrangler d1 migrations apply wagmiphotos --remote`), the `[triggers] crons` block ships with the worker (no extra setup — verify in the CF dashboard under Settings → Triggers after deploy), and the sweep semantics one-liner (re-drive at 2 min, fail+refund at 15 min).

- [ ] **Step 4: Manual check + commit**

Run `npx wrangler dev --local`, click through `#/docs`, `#/openai`, `#/agents` — no stale params, new block renders.

```bash
git add projects/worker/public/index.html DEPLOY.md
git commit -m "docs: read/write split — closest-match contract, async collection generation endpoints, deploy runbook"
```

---

### Task 10: OpenAI background-mode probe → conditional gpt-image-2 re-pin

Research first, code second. Prior findings (2026-07-10): the Responses API supports `background: true` (requires `store: true`; poll `GET /v1/responses/{id}`; terminal = `completed|failed|cancelled|incomplete`; ~10-min retention) and `image_generation` is a built-in tool — but docs list `gpt-image-1.5/1/1-mini` for the tool, so **gpt-image-2 support is unverified**, as is prompt fidelity through the host model.

- [ ] **Step 1: Write the probe script**

Create `projects/worker/scripts/probe-openai-background.sh` (needs a real `OPENAI_API_KEY` env var — ask Joris to run it or export the key; this spends ~$0.06):

```bash
#!/usr/bin/env bash
# Probe: can Responses API background mode drive gpt-image-2?
# Usage: OPENAI_API_KEY=sk-... ./probe-openai-background.sh
set -euo pipefail
SUBMIT=$(curl -s https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "background": true,
    "store": true,
    "input": "Call the image generation tool with exactly this prompt, verbatim, then stop: a watercolor fox in morning fog",
    "tools": [{"type": "image_generation", "model": "gpt-image-2", "size": "1024x1024", "quality": "medium", "output_format": "webp", "output_compression": 85}],
    "tool_choice": "required"
  }')
echo "$SUBMIT" | head -c 2000; echo
ID=$(echo "$SUBMIT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "response id: $ID — polling..."
for i in $(seq 1 60); do
  sleep 5
  R=$(curl -s "https://api.openai.com/v1/responses/$ID" -H "Authorization: Bearer $OPENAI_API_KEY")
  STATUS=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status'))")
  echo "[$((i*5))s] $STATUS"
  case "$STATUS" in
    completed) echo "$R" | python3 -c "
import json,sys
r = json.load(sys.stdin)
for item in r.get('output', []):
    if item.get('type') == 'image_generation_call':
        print('image bytes (b64) length:', len(item.get('result') or ''))
        print('revised_prompt:', item.get('revised_prompt'))
"; exit 0;;
    failed|cancelled|incomplete) echo "$R" | head -c 2000; exit 1;;
  esac
done
echo "probe timed out"; exit 1
```

- [ ] **Step 2: Run the probe and record the verdict**

Record in the plan/commit message: (a) does the tool accept `"model": "gpt-image-2"`? (b) total wall-clock, (c) does `revised_prompt` (or absence of drift) show the prompt survived verbatim-enough? **Decision gate:**
- **PASS** → continue to Step 3.
- **FAIL** (tool rejects gpt-image-2, or fidelity is unacceptable) → STOP this task. OpenAI stays `mode: "sync"` on gpt-image-1 @ $0.04 inside waitUntil — which already works end-to-end. Commit the probe script + a note in DEPLOY.md, and skip Steps 3–6.

- [ ] **Step 3 (PASS only): Failing tests for the async OpenAI provider**

In `test/providers.test.ts` add (same stub style as the GMI tests):

```ts
// 1. openai is now mode "async"
// 2. submit posts /v1/responses with background:true, store:true, tool model === PINNED.openai.model; returns response id
// 3. submit 401 -> ProviderAuthError
// 4. check maps queued/in_progress -> pending
// 5. check completed -> finds output item type "image_generation_call", decodes b64 result -> {state:"done", image.mime "image/webp"}
// 6. check failed/cancelled/incomplete -> {state:"failed", error mentions the status}
```

- [ ] **Step 4 (PASS only): Implement**

In `providers.ts`, replace `makeOpenAiProvider` with an `AsyncImageProvider`:

```ts
const OPENAI_HOST_MODEL = "gpt-5-mini"; // cheap Responses host; the image tool does the actual work
const OPENAI_SUBMIT_TIMEOUT_MS = 15_000;
const OPENAI_POLL_TIMEOUT_MS = 15_000;

function makeOpenAiProvider(fetchFn: typeof fetch): AsyncImageProvider {
  return {
    mode: "async",
    async submit(prompt, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // background+store: OpenAI runs the job server-side; every connection
        // we hold is short — the ~20s silent-connection idle-kill (diagnosed
        // live 2026-07-09) can't bite. Prompt passed verbatim via instruction
        // (fidelity verified by scripts/probe-openai-background.sh).
        body: JSON.stringify({
          model: OPENAI_HOST_MODEL, background: true, store: true,
          input: `Call the image generation tool with exactly this prompt, verbatim, then stop: ${prompt}`,
          tools: [{ type: "image_generation", model: PINNED.openai.model, size: "1024x1024", quality: "medium", output_format: "webp", output_compression: 85 }],
          tool_choice: "required",
        }),
        signal: AbortSignal.timeout(OPENAI_SUBMIT_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai responses ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const body: any = await res.json();
      if (!body?.id) throw new Error("openai responses: no id");
      return String(body.id);
    },
    async check(jobId, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/responses/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(OPENAI_POLL_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai poll ${res.status}`);
      const body: any = await res.json();
      const status = String(body?.status ?? "");
      if (status === "queued" || status === "in_progress") return { state: "pending" };
      if (status !== "completed") {
        const msg = body?.error?.message ?? body?.incomplete_details?.reason ?? "";
        return { state: "failed", error: `openai background ${status}: ${msg}`.slice(0, 300) };
      }
      const call = (body?.output ?? []).find((o: any) => o?.type === "image_generation_call" && typeof o?.result === "string");
      if (!call) return { state: "failed", error: "openai background completed without an image_generation_call result" };
      const fmt = typeof call.output_format === "string" ? call.output_format : "webp";
      return { state: "done", image: { bytes: Uint8Array.from(atob(call.result), (c) => c.charCodeAt(0)).buffer, mime: `image/${fmt}` } };
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${OPENAI_API}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(OPENAI_VALIDATE_TIMEOUT_MS),
      });
      return res.ok;
    },
  };
}
```

Delete `readSseEvent` and `OPENAI_GENERATE_TIMEOUT_MS` (nothing references the streaming path anymore; commit a01f338/c543a50 are the historical references). Remove the now-dead OpenAI streaming tests.

- [ ] **Step 5 (PASS only): Re-pin the contract**

- `contract.json`: `"openai": { "model": "gpt-image-2", "price_per_image_usd": 0.055 }`.
- `projects/worker/test/contract.test.ts`: update the pinned openai expectations.
- `grep -rn "gpt-image-1\|0\.04" projects/worker/public/index.html projects/worker/src projects/worker/test` — update every stale mention (SPA estimate copy, BYOK card text).
- `projects/common/tests/test_contract.py` pins only gmicloud — unaffected; run `cd ../.. && uv run pytest projects/common/tests/test_contract.py` to confirm.

- [ ] **Step 6: Run everything + commit**

Run: `cd projects/worker && npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(byok): OpenAI via Responses background mode — gpt-image-2 medium @ 0.055 (probe-verified); or: probe result recorded, staying on gpt-image-1"
```

---

### Task 11: Full verification, deploy, prod smoke

- [ ] **Step 1: Full local verification**

```bash
cd projects/worker && npm test
npx wrangler d1 migrations apply wagmiphotos --local
npx wrangler dev --local
```
Browser pass per the `verify` discipline: `#/library` tabs, search, collections CRUD, generate-gates (offline the provider step 500s — gates and error UX must be clean), `#/account`, `#/docs`, `#/playground` redirect. `POST /v1/images/generations` with `{"prompt":"x","cache_tolerance":0.1}` returns 200/202 (ignored field, no 422).

- [ ] **Step 2: Deploy**

```bash
npx wrangler d1 migrations apply wagmiphotos --remote
npm run deploy
```
Verify in the Cloudflare dashboard that the cron trigger appears (Settings → Triggers).

- [ ] **Step 3: Prod smoke (needs Joris + a real provider key)**

1. Log in on wagmi.photos, Collections tab, confirm BYOK key status.
2. Generate into a collection → watch the loader poll → image lands; confirm the asset appears in the collection grid with a serve-able URL; confirm usage counter incremented; confirm the image does NOT appear in the shared library search.
3. `curl -X POST https://api.wagmi.photos/v1/images/generations -H "Authorization: Bearer <key>" -d '{"prompt":"a watercolor fox"}'` → closest match, no byok field.
4. Kill a poll mid-generation (close the tab), wait ~4 min, GET the ticket → the sweep or the next poll finished it (status succeeded/failed, refund if failed).
5. Check `wrangler tail` during one generation for clean logs.

- [ ] **Step 4: Close out**

- Update `HANDOFF.md` + memory notes (async BYOK shipped; gpt-image-2 status per Task 10's verdict).
- `git push` after Joris confirms the smoke.

---

## Self-review notes (already applied)

- Spec coverage: read simplification (Task 6), creation endpoint + poll + sweep (Tasks 2/4/5), provider-side async (Tasks 3/10), migration 0016 (Task 2), SPA merge + key-management move (Tasks 7/8), docs (Task 9), real-schema testing discipline (Task 1, extended in 2/6), rollout (Task 11). Decision 2's "no user path writes to the shared library" is implemented as namespace-only vector writes (Task 4 `publish`) + unscoped LIKE-search exclusion (Task 6 Step 5) — this also hides the two pre-existing prod collection images from the global library, which is the intended end state.
- Type consistency: `GenerationStore.succeed/fail` return `Promise<boolean>` everywhere (types, d1, fakes, generation-jobs); `GenJobsCfg` is the only cfg shape passed to start/drive/sweep; `generationView` is shared by both route handlers.
- Known deliberate gaps: no `DELETE /v1/generations/:id` (YAGNI); no OpenAI cancel call (retention handles it); R2 orphan cleanup for failed jobs stays on the existing follow-up list.
