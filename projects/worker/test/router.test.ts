import { it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

afterEach(() => vi.unstubAllGlobals());

// Minimal fake env: DB stub used only by keygen/auth; VECTORIZE_* shards return no matches.
function fakeEnv(over: any = {}) {
  const db: any = {
    prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }), all: async () => ({ results: [] }) }) }),
  };
  const vectorizeStub = { query: async () => ({ matches: [] }) };
  return {
    DB: db,
    VECTORIZE_0: vectorizeStub,
    VECTORIZE_1: vectorizeStub,
    VECTORIZE_2: vectorizeStub,
    AI: { run: async () => ({ shape: [1, 2], data: [[0.1, 0.2]] }) },
    ASSETS: { fetch: async () => new Response("<!doctype html><title>SPA</title>", { status: 200, headers: { "content-type": "text/html" } }) },
    DEV_MODE: "true", // tests exercise the dev-open lane unless overridden
    ...over,
  };
}

it("healthz ok", async () => {
  const res = await worker.fetch(new Request("https://x/healthz"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
});

it("unknown non-API path is served by ASSETS (the SPA)", async () => {
  const res = await worker.fetch(new Request("https://x/playground"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

it("root path is served by ASSETS", async () => {
  const res = await worker.fetch(new Request("https://x/"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
});

it("unmatched /v1/* still returns 404 (API semantics)", async () => {
  const res = await worker.fetch(new Request("https://x/v1/does-not-exist"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});

it("generate: 401 when master key set and no bearer", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(401);
});

it("generate: 401 when neither MASTER_API_KEY nor DEV_MODE is set (fail closed)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DEV_MODE: undefined }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(401);
});

it("generate: empty pool -> 202 (open dev, embedder mocked)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(202);
});

it("generate: 429 when the rate limiter denies the request", async () => {
  // Default fakeEnv has no bearer/session, so this hits the dev-open lane,
  // which bypasses the paid gate and uses the paid (higher-tier) limiter.
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ RATE_LIMITER_PAID: { limit: async () => ({ success: false }) } }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(429);
});

it("generate: null JSON body -> 400", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: "null" }),
    fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(400);
  const j: any = await res.json();
  expect(j.error).toBe("body must be a JSON object");
});

it("healthz: GET ok, POST 404 (method-gated)", async () => {
  const get = await worker.fetch(new Request("https://x/healthz"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(get.status).toBe(200);
  const post = await worker.fetch(new Request("https://x/healthz", { method: "POST" }), fakeEnv(), { waitUntil: () => {} } as any);
  expect(post.status).toBe(404);
});

it("stars: GET returns {stars} from GitHub, POST is 404", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ stargazers_count: 42 }), { status: 200 }));
  const res = await worker.fetch(new Request("https://x/v1/meta/stars"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.stars).toBe(42);
  const post = await worker.fetch(new Request("https://x/v1/meta/stars", { method: "POST" }), fakeEnv(), { waitUntil: () => {} } as any);
  expect(post.status).toBe(404);
});

it("stars: GitHub failure degrades to {stars: null}, still 200", async () => {
  vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
  const res = await worker.fetch(new Request("https://x/v1/meta/stars"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.stars).toBeNull();
});

it("generate: upstream throw (vectorize.query throws) -> 500 without internal detail", async () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ VECTORIZE_0: { query: async () => { throw new Error("boom"); } } }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(500);
  const j: any = await res.json();
  expect(j).toEqual({ error: "internal error" }); // no String(err) leaked to the client
  expect(errSpy).toHaveBeenCalled(); // full detail still goes to the log
  errSpy.mockRestore();
});

it("library: GET returns images/has_more, POST is 404", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.images).toEqual([]);
  expect(j.has_more).toBe(false);
  const post = await worker.fetch(new Request("https://x/v1/library", { method: "POST" }), fakeEnv(), { waitUntil: () => {} } as any);
  expect(post.status).toBe(404);
});

it("library: invalid limit -> 400", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library?limit=abc"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(400);
});

it("library download: unknown id -> 404", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library/nope/download"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});

it("library download: malformed percent-encoding -> 404, not 502", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library/%zz/download"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});

it("library download: non-GET method -> 404 (method-gated)", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await worker.fetch(
      new Request("https://x/v1/library/a1/download", { method }), fakeEnv(), { waitUntil: () => {} } as any);
    expect(res.status).toBe(404);
  }
});

it("generate: 401 when gated and no principal (master set, no creds)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(401);
});

it("library: open to anonymous even when master is set -> 200", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"),
    fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
});

it("library download: open to anonymous; unknown id -> 404 (not 401)", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library/a1/download"),
    fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});

it("library: open in dev (no master) -> 200", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"), fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
});

it("auth/login: POST returns 200 generic (dev returns dev_link)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.co" }) }),
    fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(200);
});

it("me: 401 without cookie", async () => {
  const res = await worker.fetch(new Request("https://x/v1/me"), fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(401);
});

it("keys/generate: 401 without a session", async () => {
  const res = await worker.fetch(new Request("https://x/v1/keys/generate", { method: "POST" }), fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(401);
});

it("keys DELETE: 401 without a session", async () => {
  const res = await worker.fetch(new Request("https://x/v1/keys/deadbeef", { method: "DELETE" }), fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(401);
});

it("serves SPA HTML with env-configured public URLs substituted", async () => {
  const env = fakeEnv({
    ASSETS: { fetch: async () => new Response('<a href="https://api.wagmi.photos/v1">docs</a>', { status: 200, headers: { "content-type": "text/html" } }) },
    PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1",
  });
  const res = await worker.fetch(new Request("https://x/"), env, { waitUntil: () => {} } as any);
  expect(await res.text()).toBe('<a href="https://api.dev.wagmi.photos/v1">docs</a>');
});

// DB stub that returns a key owner for api_keys queries and a user row (with a
// given plan_status) for users queries — enough to drive the paid gate.
function billingDb({ owner = "usr_1", planStatus = null as string | null } = {}) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM api_keys")) return { user_id: owner };
          if (sql.includes("FROM users")) return { id: owner, email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: planStatus, plan_current_period_end: null };
          return null;
        },
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

it("generate via bearer key: 402 when the owner is not paid", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", headers: { Authorization: "Bearer sc-free" }, body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DB: billingDb({ planStatus: null }), DEV_MODE: undefined }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(402);
});

it("generate via bearer key: allowed when the owner is paid", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", headers: { Authorization: "Bearer sc-paid" }, body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DB: billingDb({ planStatus: "active" }), DEV_MODE: undefined }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(202); // empty pool -> pending (paid gate passed)
});

it("paid generation consults the paid rate limiter", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", headers: { Authorization: "Bearer sc-paid" }, body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ DB: billingDb({ planStatus: "active" }), DEV_MODE: undefined, RATE_LIMITER_PAID: { limit: async () => ({ success: false }) } }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(429);
});

it("keygen: 402 for a free user, ok for a paid user", async () => {
  // resolveSession reads sessions via env.DB; billingDb returns a user for FROM users.
  const free = await worker.fetch(
    new Request("https://x/v1/keys/generate", { method: "POST", body: "{}", headers: { Cookie: "wagmi_session=s" } }),
    fakeEnv({ DB: sessionDb({ planStatus: null }) }), { waitUntil: () => {} } as any);
  expect(free.status).toBe(402);
  const paid = await worker.fetch(
    new Request("https://x/v1/keys/generate", { method: "POST", body: "{}", headers: { Cookie: "wagmi_session=s" } }),
    fakeEnv({ DB: sessionDb({ planStatus: "active" }) }), { waitUntil: () => {} } as any);
  expect(paid.status).toBe(200);
});

// Session-authed variant: sessions.resolve reads `FROM sessions`.
function sessionDb({ planStatus = null as string | null } = {}) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM sessions")) return { user_id: "usr_1" };
          if (sql.includes("FROM users")) return { id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: null, plan_status: planStatus, plan_current_period_end: null };
          return null;
        },
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

it("webhook route: 400 on an unsigned body", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/stripe/webhook", { method: "POST", body: "{}" }),
    fakeEnv({ STRIPE_WEBHOOK_SECRET: "whsec_test" }), { waitUntil: () => {} } as any);
  expect(res.status).toBe(400);
});

it("GET /v1/collections/:id/generations dispatches to the pending-list handler (not the catch-all)", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/collections/col_x/generations?status=pending"),
    fakeEnv(), { waitUntil: () => {} } as any
  );
  expect(res.status).toBe(404);
  const body: any = await res.json();
  expect(body.error).toBe("unknown collection"); // handler ran; DB stub has no such collection
});

it("library: anonymous over the per-IP cap -> 429", async () => {
  const res = await worker.fetch(new Request("https://x/v1/library"),
    fakeEnv({ MASTER_API_KEY: "master", RATE_LIMITER_SEARCH: { limit: async () => ({ success: false }) } }),
    { waitUntil: () => {} } as any);
  expect(res.status).toBe(429);
});

it("like: POST/DELETE require a principal -> 401 when anonymous (master set)", async () => {
  for (const method of ["POST", "DELETE"]) {
    const res = await worker.fetch(new Request("https://x/v1/library/a1/like", { method }),
      fakeEnv({ MASTER_API_KEY: "master" }), { waitUntil: () => {} } as any);
    expect(res.status).toBe(401);
  }
});

it("like: authenticated POST reaches the handler — 404 on unknown id, not 401", async () => {
  // DEV_MODE=true yields a dev principal, so auth passes; the fakeEnv DB stub
  // returns null from getAsset, so the handler 404s. A 401 here would mean auth
  // failed — asserting 404 proves the authenticated like path is wired.
  const res = await worker.fetch(new Request("https://x/v1/library/a1/like", { method: "POST" }),
    fakeEnv(), { waitUntil: () => {} } as any);
  expect(res.status).toBe(404);
});
