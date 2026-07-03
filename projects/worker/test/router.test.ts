import { it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

afterEach(() => vi.unstubAllGlobals());

// Minimal fake env: DB stub used only by keygen/auth; VECTORIZE returns no matches.
function fakeEnv(over: any = {}) {
  const db: any = {
    prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }), all: async () => ({ results: [] }) }) }),
  };
  return {
    DB: db,
    VECTORIZE: { query: async () => ({ matches: [] }) },
    CLIP_TEXT_EMBED_URL: "https://clip",
    ASSETS: { fetch: async () => new Response("<!doctype html><title>SPA</title>", { status: 200, headers: { "content-type": "text/html" } }) },
    ...over,
  };
}

it("healthz ok", async () => {
  const res = await worker.fetch(new Request("https://x/healthz"), fakeEnv());
  expect(res.status).toBe(200);
});

it("unknown non-API path is served by ASSETS (the SPA)", async () => {
  const res = await worker.fetch(new Request("https://x/playground"), fakeEnv());
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

it("root path is served by ASSETS", async () => {
  const res = await worker.fetch(new Request("https://x/"), fakeEnv());
  expect(res.status).toBe(200);
});

it("unmatched /v1/* still returns 404 (API semantics)", async () => {
  const res = await worker.fetch(new Request("https://x/v1/does-not-exist"), fakeEnv());
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

it("generate: null JSON body -> 400", async () => {
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: "null" }),
    fakeEnv()
  );
  expect(res.status).toBe(400);
  const j: any = await res.json();
  expect(j.error).toBe("body must be a JSON object");
});

it("healthz: GET ok, POST 404 (method-gated)", async () => {
  const get = await worker.fetch(new Request("https://x/healthz"), fakeEnv());
  expect(get.status).toBe(200);
  const post = await worker.fetch(new Request("https://x/healthz", { method: "POST" }), fakeEnv());
  expect(post.status).toBe(404);
});

it("stars: GET returns {stars} from GitHub, POST is 404", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ stargazers_count: 42 }), { status: 200 }));
  const res = await worker.fetch(new Request("https://x/v1/meta/stars"), fakeEnv());
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.stars).toBe(42);
  const post = await worker.fetch(new Request("https://x/v1/meta/stars", { method: "POST" }), fakeEnv());
  expect(post.status).toBe(404);
});

it("stars: GitHub failure degrades to {stars: null}, still 200", async () => {
  vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
  const res = await worker.fetch(new Request("https://x/v1/meta/stars"), fakeEnv());
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j.stars).toBeNull();
});

it("generate: upstream throw (vectorize.query throws) -> structured 502", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify([[0.1, 0.2]]), { status: 200 }));
  const res = await worker.fetch(
    new Request("https://x/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
    fakeEnv({ VECTORIZE: { query: async () => { throw new Error("boom"); } } })
  );
  expect(res.status).toBe(502);
  const j: any = await res.json();
  expect(j.error).toBe("upstream error");
  expect(j.detail).toMatch(/boom/);
});
