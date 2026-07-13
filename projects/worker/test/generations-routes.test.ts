import { it, expect } from "vitest";
import { handleCreateGeneration, handleGetGeneration } from "../src/generations-routes";
import { fakeServices } from "./fakes";
import { encryptSecret } from "../src/crypto";
import { monthKey, type GenJobsCfg } from "../src/generation-jobs";
import { DEV_USER_ID } from "../src/session";
import { MAX_PROMPT_LEN } from "../src/handler";
import type { AsyncImageProvider } from "../src/providers";

// Auth: the dev-open lane (env.DEV_MODE = "true", no MASTER_API_KEY, no
// bearer/cookie on the request) resolves to principal DEV_USER_ID
// (resolveApiPrincipal in src/session.ts) — mirrors the style set by
// test/collections-routes.test.ts, just with the dev lane instead of a
// session cookie since this suite doesn't need a distinct owner per test.
const DEV_ENV: any = { DEV_MODE: "true" };
const NO_AUTH_ENV: any = {};

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const NOW = 1783468800; // 2026-07-08T00:00:00Z -> monthKey "2026-07"
const MONTH = monthKey(NOW);
const PNG = new Uint8Array([0x89, 0x50]).buffer;

const cleanModeration = (async () =>
  new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 })
) as unknown as typeof fetch;

async function giveByok(s: any, userId: string, provider = "gmicloud", opts: { enabled?: boolean; monthlyCap?: number } = {}) {
  await s.byok.put({
    userId, provider, keyCiphertext: await encryptSecret("sk-user-key", KEK), keyLast4: "1234",
    monthlyCap: opts.monthlyCap ?? 50, enabled: opts.enabled ?? true,
  });
}

function pendingAsyncProvider(): AsyncImageProvider {
  return {
    mode: "async",
    submit: async () => "job-1",
    check: async () => ({ state: "pending" }),
    validateKey: async () => true,
  };
}

function jobCfg(over: Partial<GenJobsCfg> = {}): GenJobsCfg {
  return {
    kek: KEK, moderationKey: "sk-operator", bucket: { put: async () => ({}) },
    publicUrlBase: "https://byok.example", now: () => NOW,
    fetchFn: cleanModeration, providerFor: () => pendingAsyncProvider(), uuid: () => "gen-x",
    ...over,
  };
}

function req(path: string, method = "GET", body?: any): Request {
  return new Request(`https://x${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

// ---------------------------------------------------------------------------
// POST /v1/collections/:id/generations (handleCreateGeneration)
// ---------------------------------------------------------------------------

it("1. create: unauthenticated -> 401", async () => {
  const s = fakeServices();
  const res = await handleCreateGeneration(
    "col_1", req("/v1/collections/col_1/generations", "POST", { prompt: "a cat" }), NO_AUTH_ENV, s, jobCfg()
  );
  expect(res.status).toBe(401);
});

it("2. create: unknown collection id -> 404 {error:'unknown collection'}", async () => {
  const s = fakeServices();
  const res = await handleCreateGeneration(
    "col_missing", req("/v1/collections/col_missing/generations", "POST", { prompt: "a cat" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(404);
  const body: any = await res.json();
  expect(body.error).toBe("unknown collection");
});

it("3. create: someone else's collection -> 404 (not 403 — ownership undisclosed)", async () => {
  const s = fakeServices();
  const id = "col_theirs";
  await s.collections.create({ id, ownerUserId: "usr_other", name: "n", themePrompt: "" });
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a cat" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(404);
  const body: any = await res.json();
  expect(body.error).toBe("unknown collection");
});

it("4. create: prompt missing/empty -> 422", async () => {
  const s = fakeServices();
  const id = "col_mine4";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });

  const missing = await handleCreateGeneration(id, req(`/v1/collections/${id}/generations`, "POST", {}), DEV_ENV, s, jobCfg());
  expect(missing.status).toBe(422);

  const empty = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "   " }), DEV_ENV, s, jobCfg()
  );
  expect(empty.status).toBe(422);
});

it("5. create: combined prompt (user + theme) over MAX_PROMPT_LEN -> 422 mentioning 'collection theme'", async () => {
  const s = fakeServices();
  const id = "col_theme5";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "z".repeat(50) });
  const prompt = "a".repeat(MAX_PROMPT_LEN - 10); // under MAX_PROMPT_LEN alone
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(422);
  const body: any = await res.json();
  expect(body.error).toContain("collection theme");
});

it("6. create: no byok key -> 403 {error:'byok required'}", async () => {
  const s = fakeServices();
  const id = "col_nobyok6";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(403);
  const body: any = await res.json();
  expect(body.error).toBe("byok required");
});

it("7. create: happy path (gmicloud async provider) -> 202, generating, collection id, byok.used=1", async () => {
  const s = fakeServices();
  const id = "col_happy7";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(202);
  const body: any = await res.json();
  expect(body.generation.status).toBe("generating");
  expect(body.generation.collection).toBe(id);
  expect(body.byok.used).toBe(1);
});

it("8. create: cap spent -> 429 {error:'monthly cap reached'}", async () => {
  const s = fakeServices();
  const id = "col_cap8";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud", { monthlyCap: 1 });
  expect(await s.byok.reserve(DEV_USER_ID, MONTH, 1)).toBe(true); // spend the only unit
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(429);
  const body: any = await res.json();
  expect(body.error).toBe("monthly cap reached");
});

it("9. create: denylisted prompt -> 400 {error:'content_policy'}", async () => {
  const s = fakeServices();
  const id = "col_deny9";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "pikachu at dawn" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(400);
  const body: any = await res.json();
  expect(body.error).toBe("content_policy");
});

// ---------------------------------------------------------------------------
// GET /v1/generations/:id (handleGetGeneration)
// ---------------------------------------------------------------------------

it("10. get: unauthenticated -> 401", async () => {
  const s = fakeServices();
  const res = await handleGetGeneration("gen_x", req("/v1/generations/gen_x"), NO_AUTH_ENV, s, jobCfg());
  expect(res.status).toBe(401);
});

it("11. get: someone else's generation -> 404", async () => {
  const s = fakeServices();
  await s.generations.create({ id: "gen_other11", userId: "usr_other", collectionId: "col_1", prompt: "x", provider: "gmicloud", month: MONTH });
  const res = await handleGetGeneration("gen_other11", req("/v1/generations/gen_other11"), DEV_ENV, s, jobCfg());
  expect(res.status).toBe(404);
  const body: any = await res.json();
  expect(body.error).toBe("not found");
});

it("12. get: pending job + fake provider check=pending -> 200 generating, no image", async () => {
  const s = fakeServices();
  await giveByok(s, DEV_USER_ID, "gmicloud");
  await s.generations.create({ id: "gen_g12", userId: DEV_USER_ID, collectionId: "col_1", prompt: "x", provider: "gmicloud", month: MONTH });
  await s.generations.setProviderJob("gen_g12", "job-12");
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-12",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "pending" }; },
    validateKey: async () => true,
  };
  const res = await handleGetGeneration(
    "gen_g12", req("/v1/generations/gen_g12"), DEV_ENV, s, jobCfg({ providerFor: () => provider })
  );
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.generation.status).toBe("generating");
  expect(body.generation.image).toBeUndefined();
  expect(checkCalls).toEqual(["job-12"]); // the fake provider's check() was actually invoked
});

it("13. get: fake provider check=done -> 200 succeeded with image.url/thumb_url populated", async () => {
  const s = fakeServices();
  await giveByok(s, DEV_USER_ID, "gmicloud");
  await s.generations.create({ id: "gen_g13", userId: DEV_USER_ID, collectionId: "col_scope13", prompt: "x", provider: "gmicloud", month: MONTH });
  await s.generations.setProviderJob("gen_g13", "job-13");
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-13",
    check: async () => ({ state: "done", image: { bytes: PNG, mime: "image/webp" } }),
    validateKey: async () => true,
  };
  const res = await handleGetGeneration(
    "gen_g13", req("/v1/generations/gen_g13"), DEV_ENV, s, jobCfg({ providerFor: () => provider })
  );
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.generation.status).toBe("succeeded");
  expect(body.generation.image).toBeDefined();
  expect(body.generation.image.url).toBeTruthy();
  expect(body.generation.image).toHaveProperty("thumb_url");
  expect(body.generation.image).toHaveProperty("medium_url");
  expect(body.generation.image).toHaveProperty("original_url");
  expect(body.byok).toBeDefined();
  expect(typeof body.byok.used).toBe("number");
  expect(typeof body.byok.cap).toBe("number");
  expect(typeof body.byok.est_spend_usd).toBe("number");
});

it("14. get: failed job -> 200 status 'failed' with error string", async () => {
  const s = fakeServices();
  await s.generations.create({ id: "gen_g14", userId: DEV_USER_ID, collectionId: "col_1", prompt: "x", provider: "gmicloud", month: MONTH });
  await s.generations.fail("gen_g14", "generation failed");
  const res = await handleGetGeneration("gen_g14", req("/v1/generations/gen_g14"), DEV_ENV, s, jobCfg());
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.generation.status).toBe("failed");
  expect(body.generation.error).toBe("generation failed");
});

it("15. create: malformed JSON body -> 400 {error:'invalid JSON body'}", async () => {
  const s = fakeServices();
  const id = "col_malformed15";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");

  // Create request with intentionally malformed JSON
  const malformedReq = new Request(`https://x/v1/collections/${id}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{nope", // invalid JSON
  });

  const res = await handleCreateGeneration(id, malformedReq, DEV_ENV, s, jobCfg());
  expect(res.status).toBe(400);
  const body: any = await res.json();
  expect(body.error).toBe("invalid JSON body");
});

it("16. create: rate limiter denies -> 429 {error:'Too many requests'}", async () => {
  const s = fakeServices({
    rateLimiter: { limit: async () => false },
  });
  const id = "col_ratelimit16";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");

  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(429);
  const body: any = await res.json();
  expect(body.error).toBe("Too many requests");
});

it("17. create: async provider submit throws -> 502 {error:'generation failed to start'}, refund usage", async () => {
  const s = fakeServices();
  const id = "col_provider_error17";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");

  // Override provider to throw on submit
  const failingProvider: AsyncImageProvider = {
    mode: "async",
    submit: async () => { throw new Error("boom"); },
    check: async () => ({ state: "pending" }),
    validateKey: async () => true,
  };

  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s,
    jobCfg({ providerFor: () => failingProvider })
  );

  expect(res.status).toBe(502);
  const body: any = await res.json();
  expect(body.error).toBe("generation failed to start");

  // Verify refund happened: usage count should be 0
  const usage = await s.byok.getUsage(DEV_USER_ID, MONTH);
  expect(usage.count).toBe(0);
});

it("18. create: 3 already open -> 429 {error:'concurrent_limit', limit:3}", async () => {
  const s = fakeServices();
  const id = "col_conc18";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");
  // three open generations already in flight for this user
  for (const gid of ["o1", "o2", "o3"]) {
    await s.generations.create({ id: gid, userId: DEV_USER_ID, collectionId: id, prompt: "x", provider: "gmicloud", month: MONTH });
  }
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(429);
  const body: any = await res.json();
  expect(body.error).toBe("concurrent_limit");
  expect(body.limit).toBe(3);
});

it("19. create: 2 open still allows a 3rd -> 202", async () => {
  const s = fakeServices();
  const id = "col_conc19";
  await s.collections.create({ id, ownerUserId: DEV_USER_ID, name: "n", themePrompt: "" });
  await giveByok(s, DEV_USER_ID, "gmicloud");
  for (const gid of ["p1", "p2"]) {
    await s.generations.create({ id: gid, userId: DEV_USER_ID, collectionId: id, prompt: "x", provider: "gmicloud", month: MONTH });
  }
  const res = await handleCreateGeneration(
    id, req(`/v1/collections/${id}/generations`, "POST", { prompt: "a red fox" }), DEV_ENV, s, jobCfg()
  );
  expect(res.status).toBe(202);
});
