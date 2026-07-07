import { it, expect } from "vitest";
import { rewritePublicUrls, DEFAULT_API_BASE_URL, DEFAULT_SITE_URL } from "../src/rewrite";
import type { Env } from "../src/types";

function envWith(over: Partial<Env> = {}): Env {
  return { DB: null, VECTORIZE_0: null, VECTORIZE_1: null, VECTORIZE_2: null, AI: null, ASSETS: { fetch: async () => new Response("") }, ...over } as Env;
}

function htmlRes(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-length": String(body.length) } });
}

it("rewrites both URL families when vars differ from defaults", async () => {
  const body = `<a href="${DEFAULT_API_BASE_URL}/images/generations">x</a><link rel="canonical" href="${DEFAULT_SITE_URL}/">`;
  const res = await rewritePublicUrls(htmlRes(body), envWith({
    PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1",
    PUBLIC_SITE_URL: "https://dev.wagmi.photos",
  }));
  const text = await res.text();
  expect(text).toContain("https://api.dev.wagmi.photos/v1/images/generations");
  expect(text).toContain('href="https://dev.wagmi.photos/"');
  expect(text).not.toContain(DEFAULT_API_BASE_URL);
});

it("returns the same response object when vars are unset or equal to defaults", async () => {
  const r1 = htmlRes("x");
  expect(await rewritePublicUrls(r1, envWith())).toBe(r1);
  const r2 = htmlRes("x");
  expect(await rewritePublicUrls(r2, envWith({
    PUBLIC_API_BASE_URL: DEFAULT_API_BASE_URL, PUBLIC_SITE_URL: DEFAULT_SITE_URL,
  }))).toBe(r2);
});

it("never touches non-HTML responses", async () => {
  const res = new Response("BYTES", { status: 200, headers: { "content-type": "image/webp" } });
  const out = await rewritePublicUrls(res, envWith({ PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1" }));
  expect(out).toBe(res);
  expect(res.bodyUsed).toBe(false);
});

it("drops the stale Content-Length header on rewrite", async () => {
  const res = await rewritePublicUrls(htmlRes(DEFAULT_API_BASE_URL), envWith({ PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1" }));
  expect(res.headers.get("content-length")).toBeNull();
  expect(await res.text()).toBe("https://api.dev.wagmi.photos/v1");
});

it("passes null-body responses (304) through untouched", async () => {
  const res = new Response(null, { status: 304, headers: { "content-type": "text/html" } });
  const out = await rewritePublicUrls(res, envWith({ PUBLIC_API_BASE_URL: "https://api.dev.wagmi.photos/v1" }));
  expect(out).toBe(res);
});
