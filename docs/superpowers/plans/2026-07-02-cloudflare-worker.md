# Cloudflare Worker Request Path — Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the edge request path as a Cloudflare Worker (TypeScript): authenticate, CLIP-embed the prompt, query Vectorize for the nearest cached image, read/log to D1, and return the nearest image URL — never generating at the edge.

**Architecture:** The Worker is structured as small dependency-injected modules (`clip`, `vectorize`, `d1`, `auth`, `handler`, `router`). The request handler receives a `Services` object (built from `env` bindings in production, faked in tests), so all branch logic is unit-testable by calling `worker.fetch(request, env)` directly — no Miniflare. It reads the same D1 schema and Vectorize index the Plan-1 backfill writes.

**Tech Stack:** TypeScript, Cloudflare Workers (D1 + Vectorize + Rate Limiting bindings), vitest (plain, node 22 globals), wrangler for deploy.

**Spec:** `docs/superpowers/specs/2026-07-01-cloudflare-edge-cache-design.md` (§5 request flow, §4 data model, §3 embeddings/floor, §9 env).

**Plan 1 (done):** the Python backfill worker + D1 schema (`worker/migrations/0001_init.sql`) already exist; this plan does not touch Python.

## Global Constraints

- All new code under `worker/`. TypeScript, ES modules, `moduleResolution: bundler`.
- Tests are plain **vitest** run via `npx vitest run` (from `worker/`); tests call `worker.fetch(request, env)` or module functions directly with **faked** bindings/services — NO Miniflare, NO real network, NO real Cloudflare account.
- The Worker **never generates** — no Genblaze/OpenAI at the edge. Generation is the Plan-1 backfill's job.
- Embedding space is CLIP ViT-L/14, 768-dim; the Worker computes the **query text** embedding via `fetch(env.CLIP_TEXT_EMBED_URL)`.
- Similarity floor is CLIP-cross-modal-calibrated: `FLOOR_SIM_MAX`/`FLOOR_SIM_MIN` from env (defaults `0.35`/`0.18`), same mapping as Plan-1 `floor.py`: `sim_max - t*(sim_max - sim_min)`, `t = clamp(cache_tolerance, 0, 1)`.
- D1 is SQLite (accessed via the `env.DB` binding, prepared statements with `?` params — never string-interpolate user input). Schema is fixed by `worker/migrations/0001_init.sql`: `assets`, `queries`, `api_keys` (see spec §4.2).
- API keys stored/verified as SHA-256 hex (Web Crypto). Keygen rate-limited per IP via the Rate Limiting binding.
- Response shape (spec §5): `{ created, data:[{url}], shared_cache:{ result, similarity, cost_saved_usd, model_used, source, sizes:{thumb,medium,large} } }`. `result ∈ {"hit","approximate","pending"}`. `n != 1` → 422.
- Every task ends green: `npx vitest run` (from `worker/`) passes. Commit after every task. (The Python `uv run pytest` suite is unaffected — this plan adds no Python.)

## File Structure

**Create (all under `worker/`):**
- `package.json`, `tsconfig.json`, `vitest.config.ts` — toolchain.
- `wrangler.toml` — bindings (D1 `DB`, Vectorize `VECTORIZE`, Rate Limit `RATE_LIMITER`) + vars.
- `src/types.ts` — `Env`, `AssetRow`, `Match`, and the service interfaces (`Clip`, `VectorizeStore`, `AssetStore`, `QueryStore`, `KeyStore`, `RateLimiter`) + `Services`.
- `src/floor.ts` — `similarityFloor`.
- `src/normalize.ts` — `normalizePrompt`.
- `src/embed.ts` — `clipTextEmbed(prompt, env)` (fetch-based `Clip`).
- `src/d1.ts` — `makeD1Stores(env.DB)` → `{assets, queries, keys}` over the binding.
- `src/vectorize.ts` — `makeVectorize(env.VECTORIZE)` → `VectorizeStore`.
- `src/auth.ts` — `sha256Hex`, `checkAuth`.
- `src/handler.ts` — `handleGenerate(body, services, cfg)` branch logic + `handleKeygen`.
- `src/index.ts` — `fetch(request, env)` router; builds `Services` from `env`.
- `test/*.test.ts` — one per module; `test/fakes.ts` for fake services/bindings.
- `README` update: a "Cloudflare Worker" deploy section (folded into Task 8).

---

## Task 1: Scaffold the Worker project + healthz

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/src/index.ts`, `worker/test/healthz.test.ts`
- Test: `worker/test/healthz.test.ts`

**Interfaces:**
- Produces: `export default { fetch(request: Request, env: any): Promise<Response> }`; `GET /healthz` → `200 {"status":"ok"}`.

- [ ] **Step 1: Create `worker/package.json`:**

```json
{
  "name": "sharedcache-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: Create `worker/tsconfig.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `worker/vitest.config.ts`:**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 4: Write the failing test** `worker/test/healthz.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("healthz", () => {
  it("returns ok", async () => {
    const res = await worker.fetch(new Request("https://x/healthz"), {} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 5: Install deps and run test to verify it fails**

Run: `cd worker && npm install && npx vitest run`
Expected: FAIL — `../src/index` does not exist.

- [ ] **Step 6: Create `worker/src/index.ts`:**

```ts
export default {
  async fetch(request: Request, _env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    return new Response("Not found", { status: 404 });
  },
};
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd worker && npx vitest run`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
cd worker && git add package.json tsconfig.json vitest.config.ts src/index.ts test/healthz.test.ts package-lock.json
git commit -m "chore(worker): scaffold TS Worker project + healthz"
```

---

## Task 2: Floor + prompt normalization

**Files:**
- Create: `worker/src/floor.ts`, `worker/src/normalize.ts`, `worker/test/floor.test.ts`, `worker/test/normalize.test.ts`

**Interfaces:**
- Produces: `similarityFloor(cacheTolerance: number, simMax = 0.35, simMin = 0.18): number`.
- Produces: `normalizePrompt(s: string): string` — trim, lowercase, collapse internal whitespace.

- [ ] **Step 1: Write the failing tests.** `worker/test/floor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { similarityFloor } from "../src/floor";

describe("similarityFloor", () => {
  it("maps strict->max, loose->min, clamps", () => {
    expect(similarityFloor(0)).toBeCloseTo(0.35);
    expect(similarityFloor(1)).toBeCloseTo(0.18);
    expect(similarityFloor(-5)).toBeCloseTo(0.35);
    expect(similarityFloor(9)).toBeCloseTo(0.18);
    expect(similarityFloor(0.5)).toBeGreaterThan(0.18);
    expect(similarityFloor(0.5)).toBeLessThan(0.35);
  });
  it("honors custom bounds", () => {
    expect(similarityFloor(0, 0.9, 0.5)).toBeCloseTo(0.9);
  });
});
```

`worker/test/normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizePrompt } from "../src/normalize";

describe("normalizePrompt", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizePrompt("  A  Red   Fox ")).toBe("a red fox");
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `cd worker && npx vitest run` → FAIL (modules missing).

- [ ] **Step 3: Create `worker/src/floor.ts`:**

```ts
export function similarityFloor(cacheTolerance: number, simMax = 0.35, simMin = 0.18): number {
  const t = Math.min(1, Math.max(0, cacheTolerance));
  return simMax - t * (simMax - simMin);
}
```

- [ ] **Step 4: Create `worker/src/normalize.ts`:**

```ts
export function normalizePrompt(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).join(" ");
}
```

- [ ] **Step 5: Run to verify pass.** `cd worker && npx vitest run` → PASS.

- [ ] **Step 6: Commit**

```bash
cd worker && git add src/floor.ts src/normalize.ts test/floor.test.ts test/normalize.test.ts
git commit -m "feat(worker): calibrated similarity floor + prompt normalization"
```

---

## Task 3: Types, service interfaces, fakes, and the CLIP embedder

**Files:**
- Create: `worker/src/types.ts`, `worker/src/embed.ts`, `worker/test/fakes.ts`, `worker/test/embed.test.ts`

**Interfaces:**
- Produces `types.ts`:
  - `AssetRow` = { id, prompt, source, source_id, thumb_url, medium_url, url, model_used, width, height, mime, source_url, locally_cached } (strings/nullable; `locally_cached: number` 0/1).
  - `Match` = { id: string; score: number }.
  - `Clip` = { textEmbed(prompt: string): Promise<number[]> }.
  - `VectorizeStore` = { query(vector: number[], topK: number): Promise<Match[]> }.
  - `AssetStore` = { getAsset(id: string): Promise<AssetRow | null> }.
  - `QueryStore` = { recordQuery(i: { normalized: string; original: string; assetId: string | null; similarity: number; built: boolean }): Promise<void> }.
  - `KeyStore` = { verifyKey(hash: string): Promise<boolean>; addKey(hash: string): Promise<void> }.
  - `RateLimiter` = { limit(key: string): Promise<boolean> }.
  - `Services` = { clip: Clip; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore; keys: KeyStore; rateLimiter: RateLimiter }.
  - `Env` = { DB: any; VECTORIZE: any; RATE_LIMITER?: any; MASTER_API_KEY?: string; CLIP_TEXT_EMBED_URL: string; CLIP_EMBED_TOKEN?: string; IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string }.
- Produces `embed.ts`: `clipTextEmbed(prompt: string, env: Env): Promise<number[]>` (POST `{inputs: prompt}` JSON to `env.CLIP_TEXT_EMBED_URL`, Bearer `CLIP_EMBED_TOKEN` if set; flatten `[floats] | [[floats]] | {embedding:[...]}`; throw on non-200).
- Produces `test/fakes.ts`: `fakeServices(overrides?)` returning in-memory `Services` (fake stores backed by Maps; `rateLimiter` allows by default). Used by later tasks.

- [ ] **Step 1: Create `worker/src/types.ts`** with the interfaces above:

```ts
export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  thumb_url: string | null; medium_url: string | null; url: string;
  model_used: string | null; width: number | null; height: number | null;
  mime: string | null; source_url: string | null; locally_cached: number;
}
export interface Match { id: string; score: number; }
export interface Clip { textEmbed(prompt: string): Promise<number[]>; }
export interface VectorizeStore { query(vector: number[], topK: number): Promise<Match[]>; }
export interface AssetStore { getAsset(id: string): Promise<AssetRow | null>; }
export interface QueryStore {
  recordQuery(i: { normalized: string; original: string; assetId: string | null; similarity: number; built: boolean }): Promise<void>;
}
export interface KeyStore { verifyKey(hash: string): Promise<boolean>; addKey(hash: string): Promise<void>; }
export interface RateLimiter { limit(key: string): Promise<boolean>; }
export interface Services {
  clip: Clip; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore; keys: KeyStore; rateLimiter: RateLimiter;
}
export interface Env {
  DB: any; VECTORIZE: any; RATE_LIMITER?: any;
  MASTER_API_KEY?: string; CLIP_TEXT_EMBED_URL: string; CLIP_EMBED_TOKEN?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
}
```

- [ ] **Step 2: Write the failing embed test** `worker/test/embed.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { clipTextEmbed } from "../src/embed";

afterEach(() => vi.unstubAllGlobals());

const env: any = { CLIP_TEXT_EMBED_URL: "https://clip/text", CLIP_EMBED_TOKEN: "tok" };

it("posts inputs json with bearer and flattens", async () => {
  const seen: any = {};
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    seen.url = url; seen.body = JSON.parse(init.body); seen.auth = init.headers["Authorization"];
    return new Response(JSON.stringify([[0.1, 0.2, 0.3]]), { status: 200 });
  });
  const v = await clipTextEmbed("a red fox", env);
  expect(v).toEqual([0.1, 0.2, 0.3]);
  expect(seen.url).toBe("https://clip/text");
  expect(seen.body).toEqual({ inputs: "a red fox" });
  expect(seen.auth).toBe("Bearer tok");
});

it("throws on non-200", async () => {
  vi.stubGlobal("fetch", async () => new Response("boom", { status: 503 }));
  await expect(clipTextEmbed("x", env)).rejects.toThrow();
});
```

- [ ] **Step 3: Run to verify fail.** `cd worker && npx vitest run test/embed.test.ts` → FAIL.

- [ ] **Step 4: Create `worker/src/embed.ts`:**

```ts
import type { Env } from "./types";

function flatten(data: any): number[] {
  if (data && typeof data === "object" && "embedding" in data) data = data.embedding;
  if (Array.isArray(data) && Array.isArray(data[0])) data = data[0];
  if (!Array.isArray(data) || typeof data[0] !== "number") {
    throw new Error(`Unexpected embedding response: ${JSON.stringify(data)}`);
  }
  return data as number[];
}

export async function clipTextEmbed(prompt: string, env: Env): Promise<number[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.CLIP_EMBED_TOKEN) headers["Authorization"] = `Bearer ${env.CLIP_EMBED_TOKEN}`;
  const res = await fetch(env.CLIP_TEXT_EMBED_URL, { method: "POST", headers, body: JSON.stringify({ inputs: prompt }) });
  if (res.status !== 200) throw new Error(`CLIP text embed failed (${res.status}): ${await res.text()}`);
  return flatten(await res.json());
}
```

- [ ] **Step 5: Create `worker/test/fakes.ts`:**

```ts
import type { Services, AssetRow, Match } from "../src/types";

export function fakeServices(overrides: Partial<Services> = {}): Services {
  const assets = new Map<string, AssetRow>();
  const recorded: any[] = [];
  const keyHashes = new Set<string>();
  const matches: Match[] = [];
  const base: Services = {
    clip: { textEmbed: async () => [0.1, 0.2, 0.3] },
    vectorize: { query: async () => matches },
    assets: { getAsset: async (id) => assets.get(id) ?? null },
    queries: { recordQuery: async (i) => { recorded.push(i); } },
    keys: { verifyKey: async (h) => keyHashes.has(h), addKey: async (h) => { keyHashes.add(h); } },
    rateLimiter: { limit: async () => true },
  };
  // expose internals for assertions
  (base as any)._assets = assets;
  (base as any)._recorded = recorded;
  (base as any)._matches = matches;
  (base as any)._keyHashes = keyHashes;
  return { ...base, ...overrides };
}
```

- [ ] **Step 6: Run to verify embed passes.** `cd worker && npx vitest run` → PASS (all so far).

- [ ] **Step 7: Commit**

```bash
cd worker && git add src/types.ts src/embed.ts test/fakes.ts test/embed.test.ts
git commit -m "feat(worker): service interfaces, fakes, and CLIP text embedder"
```

---

## Task 4: D1 stores

**Files:**
- Create: `worker/src/d1.ts`, `worker/test/d1.test.ts`

**Interfaces:**
- Consumes: `AssetRow`, `AssetStore`, `QueryStore`, `KeyStore` (Task 3).
- Produces: `makeD1Stores(db: D1Database): { assets: AssetStore; queries: QueryStore; keys: KeyStore }`. Uses the D1 binding API (`db.prepare(sql).bind(...args).first()/all()/run()`), `?` placeholders. `recordQuery` upserts into `queries` (count+1, status transitions to 'built' only forward). `getAsset` returns the row mapped to `AssetRow` or null.

- [ ] **Step 1: Write the failing test** `worker/test/d1.test.ts` (fake D1 binding capturing SQL + args):

```ts
import { describe, it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";

function fakeDb(firstResult: any = null) {
  const calls: { sql: string; args: any[] }[] = [];
  const db: any = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as any[],
        bind(...args: any[]) { this._args = args; return this; },
        async first() { calls.push({ sql, args: this._args }); return firstResult; },
        async run() { calls.push({ sql, args: this._args }); return { success: true }; },
        async all() { calls.push({ sql, args: this._args }); return { results: [] }; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

it("getAsset selects by id and maps row", async () => {
  const row = { id: "a1", prompt: "p", source: "pd12m", source_id: "7", thumb_url: null,
    medium_url: null, url: "https://ext/x.jpg", model_used: "clip-vit-l-14", width: 10, height: 20,
    mime: "image/jpeg", source_url: "https://ext/x.jpg", locally_cached: 0 };
  const { db, calls } = fakeDb(row);
  const { assets } = makeD1Stores(db);
  const got = await assets.getAsset("a1");
  expect(got?.id).toBe("a1");
  expect(calls[0].sql).toContain("FROM assets");
  expect(calls[0].args).toEqual(["a1"]);
});

it("getAsset returns null when missing", async () => {
  const { db } = fakeDb(null);
  const { assets } = makeD1Stores(db);
  expect(await assets.getAsset("nope")).toBeNull();
});

it("recordQuery upserts with count increment and forward-only built", async () => {
  const { db, calls } = fakeDb();
  const { queries } = makeD1Stores(db);
  await queries.recordQuery({ normalized: "a fox", original: "A Fox", assetId: "a1", similarity: 0.3, built: true });
  expect(calls[0].sql).toContain("INSERT INTO queries");
  expect(calls[0].sql).toContain("ON CONFLICT");
  expect(calls[0].sql).toContain("count = queries.count + 1");
  // status param is 'built' when built=true, else 'pending'
  expect(calls[0].args).toContain("built");
  expect(calls[0].args).toContain("a fox");
});

it("verifyKey and addKey hit api_keys", async () => {
  const { db, calls } = fakeDb({ 1: 1 });
  const { keys } = makeD1Stores(db);
  expect(await keys.verifyKey("hashX")).toBe(true);
  expect(calls[0].sql).toContain("FROM api_keys");
  expect(calls[0].args).toEqual(["hashX"]);
  await keys.addKey("hashY");
  expect(calls[1].sql).toContain("INSERT");
  expect(calls[1].sql).toContain("api_keys");
  expect(calls[1].args).toEqual(["hashY"]);
});
```

- [ ] **Step 2: Run to verify fail.** `cd worker && npx vitest run test/d1.test.ts` → FAIL.

- [ ] **Step 3: Create `worker/src/d1.ts`:**

```ts
import type { AssetRow, AssetStore, QueryStore, KeyStore } from "./types";

const ASSET_COLS =
  "id, prompt, source, source_id, thumb_url, medium_url, url, model_used, width, height, mime, source_url, locally_cached";

export function makeD1Stores(db: any): { assets: AssetStore; queries: QueryStore; keys: KeyStore } {
  const assets: AssetStore = {
    async getAsset(id) {
      const row = await db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).bind(id).first();
      return (row as AssetRow) ?? null;
    },
  };
  const queries: QueryStore = {
    async recordQuery({ normalized, original, assetId, similarity, built }) {
      const status = built ? "built" : "pending";
      await db.prepare(
        `INSERT INTO queries (normalized_prompt, original_prompt, count, status, last_asset_id, last_similarity)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(normalized_prompt) DO UPDATE SET
           count = queries.count + 1,
           original_prompt = excluded.original_prompt,
           last_similarity = excluded.last_similarity,
           last_seen = datetime('now'),
           last_asset_id = COALESCE(excluded.last_asset_id, queries.last_asset_id),
           status = CASE WHEN queries.status = 'built' THEN 'built' ELSE excluded.status END`
      ).bind(normalized, original, status, assetId, similarity).run();
    },
  };
  const keys: KeyStore = {
    async verifyKey(hash) {
      const row = await db.prepare("SELECT 1 FROM api_keys WHERE key_hash = ?").bind(hash).first();
      return row != null;
    },
    async addKey(hash) {
      await db.prepare("INSERT OR IGNORE INTO api_keys (key_hash) VALUES (?)").bind(hash).run();
    },
  };
  return { assets, queries, keys };
}
```

- [ ] **Step 4: Run to verify pass.** `cd worker && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
cd worker && git add src/d1.ts test/d1.test.ts
git commit -m "feat(worker): D1 stores (assets, queries upsert, api keys)"
```

---

## Task 5: Auth + key hashing

**Files:**
- Create: `worker/src/auth.ts`, `worker/test/auth.test.ts`

**Interfaces:**
- Consumes: `KeyStore` (Task 3).
- Produces: `sha256Hex(s: string): Promise<string>` (Web Crypto); `checkAuth(request: Request, env: Env, keys: KeyStore): Promise<boolean>` — true if `MASTER_API_KEY` unset (open dev), or bearer token equals `MASTER_API_KEY`, or `sha256Hex(token)` verifies in `keys`.

- [ ] **Step 1: Write the failing test** `worker/test/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sha256Hex, checkAuth } from "../src/auth";
import { fakeServices } from "./fakes";

function req(token?: string) {
  const h: any = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return new Request("https://x/v1/images/generations", { method: "POST", headers: h });
}

it("sha256Hex is stable hex", async () => {
  const h = await sha256Hex("sc-secret");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(await sha256Hex("sc-secret")).toBe(h);
});

it("open when MASTER_API_KEY unset", async () => {
  const s = fakeServices();
  expect(await checkAuth(req(), {} as any, s.keys)).toBe(true);
});

it("accepts master key, rejects wrong", async () => {
  const s = fakeServices();
  const env: any = { MASTER_API_KEY: "master" };
  expect(await checkAuth(req("master"), env, s.keys)).toBe(true);
  expect(await checkAuth(req("nope"), env, s.keys)).toBe(false);
  expect(await checkAuth(req(), env, s.keys)).toBe(false);
});

it("accepts a db-registered hashed key", async () => {
  const s = fakeServices();
  const env: any = { MASTER_API_KEY: "master" };
  await s.keys.addKey(await sha256Hex("sc-user"));
  expect(await checkAuth(req("sc-user"), env, s.keys)).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail.** `cd worker && npx vitest run test/auth.test.ts` → FAIL.

- [ ] **Step 3: Create `worker/src/auth.ts`:**

```ts
import type { Env, KeyStore } from "./types";

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

export async function checkAuth(request: Request, env: Env, keys: KeyStore): Promise<boolean> {
  if (!env.MASTER_API_KEY) return true; // open in dev
  const token = bearer(request);
  if (!token) return false;
  if (token === env.MASTER_API_KEY) return true;
  return keys.verifyKey(await sha256Hex(token));
}
```

- [ ] **Step 4: Run to verify pass.** `cd worker && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
cd worker && git add src/auth.ts test/auth.test.ts
git commit -m "feat(worker): bearer auth + SHA-256 key hashing"
```

---

## Task 6: Generate handler (branch logic)

**Files:**
- Create: `worker/src/handler.ts`, `worker/test/handler.test.ts`

**Interfaces:**
- Consumes: `Services`, `AssetRow`, `similarityFloor`, `normalizePrompt`, `clipTextEmbed` (via `services.clip`).
- Produces: `handleGenerate(body, services, cfg): Promise<Response>` where `body = { prompt, n?, size?, cache_tolerance? }`, `cfg = { floorSimMax, floorSimMin, imagePrice, now }` (`now: () => number` seconds). Branch per spec §5: hit / hit-not-rehosted (both `result:"hit"`) / approximate / empty (`202 {result:"pending"}`). Records the query each time. `n != 1` → `422`.
- Produces: `handleKeygen(request, services, gen): Promise<Response>` — rate-limit by IP, mint `sc-...`, store `sha256Hex`, return `{ key }` or `429`.

- [ ] **Step 1: Write the failing tests** `worker/test/handler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { handleGenerate, handleKeygen } from "../src/handler";
import { fakeServices } from "./fakes";
import type { AssetRow } from "../src/types";

const cfg = { floorSimMax: 0.35, floorSimMin: 0.18, imagePrice: 0.04, now: () => 1000 };

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "a1", prompt: "p", source: "pd12m", source_id: "7", thumb_url: "T", medium_url: "M",
    url: "https://cdn/large.webp", model_used: "clip-vit-l-14", width: 10, height: 20,
    mime: "image/webp", source_url: "https://ext/x.jpg", locally_cached: 1, ...over };
}

it("rejects n != 1 with 422", async () => {
  const s = fakeServices();
  const res = await handleGenerate({ prompt: "x", n: 2 }, s, cfg);
  expect(res.status).toBe(422);
});

it("hit: score >= floor, cached -> result hit + cost saved", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(res.status).toBe(200);
  expect(j.data[0].url).toBe("https://cdn/large.webp");
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.cost_saved_usd).toBe(0.04);
  expect(j.shared_cache.sizes).toEqual({ thumb: "T", medium: "M", large: "https://cdn/large.webp" });
  const rec = (s as any)._recorded[0];
  expect(rec).toMatchObject({ normalized: "a fox", assetId: "a1", built: true });
});

it("hit-not-rehosted: serves source_url, still result hit", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset({ locally_cached: 0, url: "https://ext/x.jpg", thumb_url: null, medium_url: null }));
  (s as any)._matches.push({ id: "a1", score: 0.40 });
  const res = await handleGenerate({ prompt: "a fox" }, s, cfg);
  const j: any = await res.json();
  expect(j.data[0].url).toBe("https://ext/x.jpg");
  expect(j.shared_cache.result).toBe("hit");
  expect(j.shared_cache.sizes.thumb).toBeNull();
});

it("approximate: score < floor -> result approximate + pending query", async () => {
  const s = fakeServices();
  (s as any)._assets.set("a1", asset());
  (s as any)._matches.push({ id: "a1", score: 0.20 }); // below floor(0.15)~0.32
  const res = await handleGenerate({ prompt: "a fox", cache_tolerance: 0.15 }, s, cfg);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("approximate");
  expect(j.shared_cache.cost_saved_usd).toBe(0.04);
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: "a1" });
});

it("empty pool -> 202 pending, query logged without asset", async () => {
  const s = fakeServices(); // no matches
  const res = await handleGenerate({ prompt: "nothing here" }, s, cfg);
  expect(res.status).toBe(202);
  const j: any = await res.json();
  expect(j.shared_cache.result).toBe("pending");
  expect((s as any)._recorded[0]).toMatchObject({ built: false, assetId: null });
});

it("keygen mints and stores a hashed key", async () => {
  const s = fakeServices();
  const res = await handleKeygen(new Request("https://x", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), s, () => "sc-fixed");
  const j: any = await res.json();
  expect(j.key).toBe("sc-fixed");
  expect((s as any)._keyHashes.size).toBe(1);
});

it("keygen 429 when rate limited", async () => {
  const s = fakeServices({ rateLimiter: { limit: async () => false } });
  const res = await handleKeygen(new Request("https://x"), s, () => "sc-fixed");
  expect(res.status).toBe(429);
});
```

- [ ] **Step 2: Run to verify fail.** `cd worker && npx vitest run test/handler.test.ts` → FAIL.

- [ ] **Step 3: Create `worker/src/handler.ts`:**

```ts
import type { Services } from "./types";
import { similarityFloor } from "./floor";
import { normalizePrompt } from "./normalize";
import { sha256Hex } from "./auth";

export interface GenBody { prompt: string; n?: number; size?: string; cache_tolerance?: number; }
export interface GenCfg { floorSimMax: number; floorSimMin: number; imagePrice: number; now: () => number; }

export async function handleGenerate(body: GenBody, s: Services, cfg: GenCfg): Promise<Response> {
  if (body.n != null && body.n !== 1) {
    return Response.json({ error: "only n=1 is supported" }, { status: 422 });
  }
  const prompt = body.prompt ?? "";
  const tol = body.cache_tolerance ?? 0.15;
  const floor = similarityFloor(tol, cfg.floorSimMax, cfg.floorSimMin);
  const normalized = normalizePrompt(prompt);

  const vec = await s.clip.textEmbed(prompt);
  const matches = await s.vectorize.query(vec, 1);
  const best = matches[0] ?? null;
  const asset = best ? await s.assets.getAsset(best.id) : null;

  // empty pool: nothing to serve
  if (!best || !asset) {
    await s.queries.recordQuery({ normalized, original: prompt, assetId: null, similarity: 0, built: false });
    return Response.json(
      { created: cfg.now(), data: [], shared_cache: { result: "pending", similarity: 0, cost_saved_usd: 0 } },
      { status: 202 }
    );
  }

  const isHit = best.score >= floor;
  const result = isHit ? "hit" : "approximate";
  await s.queries.recordQuery({
    normalized, original: prompt, assetId: asset.id, similarity: best.score, built: isHit,
  });
  return Response.json({
    created: cfg.now(),
    data: [{ url: asset.url }],
    shared_cache: {
      result,
      similarity: best.score,
      cost_saved_usd: cfg.imagePrice,
      model_used: asset.model_used,
      source: asset.source,
      sizes: { thumb: asset.thumb_url, medium: asset.medium_url, large: asset.url },
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export async function handleKeygen(request: Request, s: Services, genKey: () => string): Promise<Response> {
  const ok = await s.rateLimiter.limit(clientIp(request));
  if (!ok) return Response.json({ error: "Too many key requests" }, { status: 429 });
  const key = genKey();
  await s.keys.addKey(await sha256Hex(key));
  return Response.json({ key, created_at: Date.now() });
}
```

- [ ] **Step 4: Run to verify pass.** `cd worker && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
cd worker && git add src/handler.ts test/handler.test.ts
git commit -m "feat(worker): generate branch logic (hit/approximate/pending) + keygen"
```

---

## Task 7: Router + service wiring

**Files:**
- Modify: `worker/src/index.ts`
- Test: `worker/test/router.test.ts`

**Interfaces:**
- Consumes: `handleGenerate`, `handleKeygen`, `checkAuth`, `makeD1Stores`, `makeVectorize` (created here), `clipTextEmbed`.
- Produces: `worker/src/vectorize.ts` `makeVectorize(binding): VectorizeStore`; updated `index.ts` `fetch` routing `POST /v1/images/generations` (auth → build services → handleGenerate), `POST /v1/keys/generate`, `GET /healthz`, else 404; `401` on failed auth.

- [ ] **Step 1: Create `worker/src/vectorize.ts`:**

```ts
import type { VectorizeStore, Match } from "./types";

export function makeVectorize(binding: any): VectorizeStore {
  return {
    async query(vector, topK) {
      const res = await binding.query(vector, { topK });
      return (res.matches ?? []).map((m: any): Match => ({ id: m.id, score: m.score }));
    },
  };
}
```

- [ ] **Step 2: Write the failing router test** `worker/test/router.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

afterEach(() => vi.unstubAllGlobals());

// Minimal fake env: DB stub used only by keygen/auth; VECTORIZE returns no matches.
function fakeEnv(over: any = {}) {
  const db: any = {
    prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }), all: async () => ({ results: [] }) }) }),
  };
  return { DB: db, VECTORIZE: { query: async () => ({ matches: [] }) }, CLIP_TEXT_EMBED_URL: "https://clip", ...over };
}

it("healthz ok", async () => {
  const res = await worker.fetch(new Request("https://x/healthz"), fakeEnv());
  expect(res.status).toBe(200);
});

it("unknown route 404", async () => {
  const res = await worker.fetch(new Request("https://x/nope"), fakeEnv());
  expect(res.status).toBe(404);
});

it("generate: 401 when master key set and no bearer", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ MASTER_API_KEY: "master" })
  );
  expect(res.status).toBe(401);
});

it("generate: empty pool -> 202 (open dev, clip mocked)", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify([[0.1, 0.2]]), { status: 200 }));
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv()
  );
  expect(res.status).toBe(202);
});
```

- [ ] **Step 3: Run to verify fail.** `cd worker && npx vitest run test/router.test.ts` → FAIL (routing not implemented).

- [ ] **Step 4: Rewrite `worker/src/index.ts`:**

```ts
import type { Env, Services, RateLimiter } from "./types";
import { makeD1Stores } from "./d1";
import { makeVectorize } from "./vectorize";
import { clipTextEmbed } from "./embed";
import { checkAuth } from "./auth";
import { handleGenerate, handleKeygen, type GenBody } from "./handler";

function buildServices(env: Env): Services {
  const { assets, queries, keys } = makeD1Stores(env.DB);
  const rateLimiter: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER.limit({ key });
      return success;
    },
  };
  return {
    clip: { textEmbed: (p) => clipTextEmbed(p, env) },
    vectorize: makeVectorize(env.VECTORIZE),
    assets, queries, keys, rateLimiter,
  };
}

function genKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `sc-${b64}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ status: "ok" });

    if (url.pathname === "/v1/keys/generate" && request.method === "POST") {
      return handleKeygen(request, buildServices(env), genKey);
    }

    if (url.pathname === "/v1/images/generations" && request.method === "POST") {
      const services = buildServices(env);
      if (!(await checkAuth(request, env, services.keys))) {
        return Response.json({ error: "Invalid API Key" }, { status: 401 });
      }
      let body: GenBody;
      try { body = (await request.json()) as GenBody; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      const cfg = {
        floorSimMax: env.FLOOR_SIM_MAX ? Number(env.FLOOR_SIM_MAX) : 0.35,
        floorSimMin: env.FLOOR_SIM_MIN ? Number(env.FLOOR_SIM_MIN) : 0.18,
        imagePrice: env.IMAGE_PRICE_USD ? Number(env.IMAGE_PRICE_USD) : 0.04,
        now: () => Math.floor(Date.now() / 1000),
      };
      return handleGenerate(body, services, cfg);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

- [ ] **Step 5: Run to verify pass.** `cd worker && npx vitest run` → PASS (all tests, all files).

- [ ] **Step 6: Commit**

```bash
cd worker && git add src/index.ts src/vectorize.ts test/router.test.ts
git commit -m "feat(worker): router + service wiring (generate, keygen, healthz, auth)"
```

---

## Task 8: wrangler.toml + deploy runbook

**Files:**
- Create: `worker/wrangler.toml`
- Modify: `README.md` (Cloudflare Worker section)
- Test: `cd worker && npx vitest run` (unchanged, still green) + `npx wrangler deploy --dry-run` if it runs offline.

- [ ] **Step 1: Create `worker/wrangler.toml`** (bindings + vars; ids are operator-set placeholders documented as such):

```toml
name = "sharedcache-worker"
main = "src/index.ts"
compatibility_date = "2026-06-01"

# D1 — same database the backfill/seed write (set database_id after `wrangler d1 create`)
[[d1_databases]]
binding = "DB"
database_name = "sharedcache"
database_id = "REPLACE_WITH_D1_DATABASE_ID"

# Vectorize — CLIP index (create: wrangler vectorize create sharedcache-clip --dimensions=768 --metric=cosine)
[[vectorize]]
binding = "VECTORIZE"
index_name = "sharedcache-clip"

# Per-IP rate limit for key generation
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 10, period = 60 }

[vars]
CLIP_TEXT_EMBED_URL = ""   # set to your CLIP ViT-L/14 text endpoint
FLOOR_SIM_MAX = "0.35"
FLOOR_SIM_MIN = "0.18"
IMAGE_PRICE_USD = "0.04"
# Secrets (set with `wrangler secret put`): MASTER_API_KEY, CLIP_EMBED_TOKEN
```

- [ ] **Step 2: Add a "Cloudflare Worker (edge request path)" section to `README.md`** documenting: `cd worker && npm install`; set `database_id` (from `wrangler d1 create sharedcache`) and apply the migration (`wrangler d1 migrations apply sharedcache`); create the Vectorize index; `wrangler secret put MASTER_API_KEY` / `CLIP_EMBED_TOKEN`; set `CLIP_TEXT_EMBED_URL`; `npm test`; `npm run deploy`. Note the Worker is the request path and the Python backfill (Plan 1) populates the same D1 + Vectorize.

- [ ] **Step 3: Verify tests still green.** `cd worker && npx vitest run` → PASS.

- [ ] **Step 4: If it runs offline, sanity-check config:** `cd worker && npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry 2>&1 | tail -20` (expected: bundles `src/index.ts` without a real account; if it requires auth/network, note that and skip — config is validated by inspection).

- [ ] **Step 5: Commit**

```bash
cd worker && git add wrangler.toml && cd .. && git add README.md
git commit -m "chore(worker): wrangler config + deploy runbook"
```

---

## Self-Review Notes (author checklist — done)

- **Spec coverage:** §5 request flow → Tasks 6 (branch logic) + 7 (routing/auth); §3 floor/embeddings → Tasks 2 (floor) + 3 (embed); §4.2 D1 access → Task 4 (matches the Plan-1 schema columns); §5 keygen + rate limit → Tasks 6/7; §9 env/bindings → Tasks 3 (Env) + 8 (wrangler). Empty-pool 202, hit-not-rehosted-serves-source_url, and `n!=1`→422 all covered in Task 6.
- **Type consistency:** `Services`/`AssetRow`/`Match`/`Clip`/`VectorizeStore`/`AssetStore`/`QueryStore`/`KeyStore`/`RateLimiter` defined in Task 3 and consumed unchanged in Tasks 4–7; `handleGenerate(body, services, cfg)` and `handleKeygen(request, services, genKey)` signatures stable between Task 6 (def) and Task 7 (call); D1 column list in Task 4 matches `worker/migrations/0001_init.sql` (Plan 1).
- **Placeholder scan:** all code steps carry full code; `wrangler.toml` ids/URLs are operator-set blanks, documented as such.
- **Test approach:** plain vitest, `worker.fetch(request, env)` / module calls with faked bindings/services — no Miniflare, no network (CLIP `fetch` is stubbed). Live Miniflare/deploy verification is a separate step (spec §12).
- **Ordering:** scaffold → pure utils → interfaces+embed → d1 → auth → handler → router → config, so `npx vitest run` stays green at each task.
