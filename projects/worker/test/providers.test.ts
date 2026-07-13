import { it, expect } from "vitest";
import { providerFor, ProviderAuthError, type AsyncImageProvider } from "../src/providers";
import contract from "../../../contract.json";

// OpenAI is now an async provider (Responses API background mode, probe-verified
// 2026-07-10: gpt-image-2 accepted, completed in 70s, revised_prompt verbatim).
function openai(fetchFn: typeof fetch): AsyncImageProvider {
  return providerFor("openai", fetchFn) as AsyncImageProvider;
}

const PINNED_OPENAI_MODEL = (contract as any).byok_providers.openai.model;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// 1. openai is now mode "async"
it("openai is an async provider", () => {
  const fetchFn = (async () => { throw new Error("unused"); }) as unknown as typeof fetch;
  expect(openai(fetchFn).mode).toBe("async");
});

// 2. submit posts /v1/responses with background:true, store:true, tool model === PINNED.openai.model; returns response id
it("openai submit posts /v1/responses with background+store and the pinned tool model; returns the response id", async () => {
  const calls: any[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), init });
    return okJson({ id: "resp_123", status: "queued" });
  }) as unknown as typeof fetch;
  const id = await openai(fetchFn).submit("a red fox", "sk-user");
  expect(id).toBe("resp_123");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].body.background).toBe(true);
  expect(calls[0].body.store).toBe(true);
  expect(calls[0].body.model).toBe("gpt-5-mini");
  expect(calls[0].body.tool_choice).toBe("required");
  expect(calls[0].body.input).toContain("a red fox");
  expect(calls[0].body.tools).toEqual([
    { type: "image_generation", model: PINNED_OPENAI_MODEL, size: "1024x1024", quality: "medium", output_format: "webp", output_compression: 85 },
  ]);
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
});

// 3. submit 401 -> ProviderAuthError
it("openai submit 401/403 throws ProviderAuthError", async () => {
  const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await expect(openai(fetchFn).submit("x", "bad")).rejects.toBeInstanceOf(ProviderAuthError);
});

// 4. check maps queued/in_progress -> pending
it("openai check maps queued/in_progress -> pending", async () => {
  const queuedFetch = (async (url: any) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses/resp_123");
    return okJson({ status: "queued" });
  }) as unknown as typeof fetch;
  expect(await openai(queuedFetch).check("resp_123", "sk-user")).toEqual({ state: "pending" });

  const inProgressFetch = (async () => okJson({ status: "in_progress" })) as unknown as typeof fetch;
  expect(await openai(inProgressFetch).check("resp_123", "sk-user")).toEqual({ state: "pending" });
});

// 5. check completed -> finds output item type "image_generation_call", decodes b64 result -> {state:"done", image.mime "image/webp"}
it("openai check completed -> decodes the image_generation_call result", async () => {
  const b64 = btoa("\x89PNG");
  const fetchFn = (async () => okJson({
    status: "completed",
    output: [
      { type: "reasoning", content: [] },
      { type: "image_generation_call", result: b64, output_format: "webp", revised_prompt: "a red fox" },
    ],
  })) as unknown as typeof fetch;
  const result = await openai(fetchFn).check("resp_123", "sk-user");
  expect(result.state).toBe("done");
  expect((result as any).image.mime).toBe("image/webp");
  expect(new Uint8Array((result as any).image.bytes)).toEqual(new Uint8Array(PNG));
});

// 6. check failed/cancelled/incomplete -> {state:"failed", error mentions the status}
it("openai check failed/cancelled/incomplete -> failed, error mentions the status", async () => {
  const failedFetch = (async () => okJson({ status: "failed", error: { message: "boom" } })) as unknown as typeof fetch;
  const failedResult = await openai(failedFetch).check("resp_123", "sk-user");
  expect(failedResult.state).toBe("failed");
  expect((failedResult as any).error).toMatch(/failed/);

  const cancelledFetch = (async () => okJson({ status: "cancelled" })) as unknown as typeof fetch;
  const cancelledResult = await openai(cancelledFetch).check("resp_123", "sk-user");
  expect(cancelledResult.state).toBe("failed");
  expect((cancelledResult as any).error).toMatch(/cancelled/);

  const incompleteFetch = (async () => okJson({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })) as unknown as typeof fetch;
  const incompleteResult = await openai(incompleteFetch).check("resp_123", "sk-user");
  expect(incompleteResult.state).toBe("failed");
  expect((incompleteResult as any).error).toMatch(/incomplete/);
});

it("openai check throws ProviderAuthError on 401/403", async () => {
  const fetchFn = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  await expect(openai(fetchFn).check("resp_123", "bad")).rejects.toBeInstanceOf(ProviderAuthError);
});

it("openai check completed without an image_generation_call result -> failed", async () => {
  const fetchFn = (async () => okJson({ status: "completed", output: [{ type: "message", content: [] }] })) as unknown as typeof fetch;
  const result = await openai(fetchFn).check("resp_123", "sk-user");
  expect(result.state).toBe("failed");
  expect((result as any).error).toMatch(/without an image_generation_call/);
});

it("openai validateKey pings /models", async () => {
  const fetchFn = (async (url: any) => {
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    return okJson({ data: [] });
  }) as unknown as typeof fetch;
  expect(await providerFor("openai", fetchFn).validateKey("sk-user")).toBe(true);
});

it("gmicloud is an async provider", () => {
  const fetchFn = (async () => { throw new Error("unused"); }) as unknown as typeof fetch;
  expect((providerFor("gmicloud", fetchFn) as AsyncImageProvider).mode).toBe("async");
});

it("gmi submit posts the pinned model and returns the request id", async () => {
  const calls: any[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), init });
    return okJson({ request_id: "req-1" });
  }) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn) as AsyncImageProvider;
  const id = await gmi.submit("a red fox", "gmi-key");
  expect(id).toBe("req-1");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests");
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].body).toEqual({ model: "gpt-image-2-generate", payload: { prompt: "a red fox", size: "1024x1024" } });
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
});

it("gmi submit throws ProviderAuthError on 401/403", async () => {
  const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn) as AsyncImageProvider;
  await expect(gmi.submit("x", "bad-key")).rejects.toBeInstanceOf(ProviderAuthError);
});

it("gmi check maps status running -> pending", async () => {
  const calls: any[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return okJson({ status: "running" });
  }) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn) as AsyncImageProvider;
  const result = await gmi.check("req-1", "gmi-key");
  expect(result).toEqual({ state: "pending" });
  expect(calls).toHaveLength(1); // exactly one status call, no loop
  expect(calls[0].url).toBe("https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests/req-1");
});

it("gmi check maps failed/cancelled -> failed with the provider error", async () => {
  const failedFetch = (async () => okJson({ status: "failed", error: "nsfw" })) as unknown as typeof fetch;
  const failedResult = await (providerFor("gmicloud", failedFetch) as AsyncImageProvider).check("req-1", "k");
  expect(failedResult.state).toBe("failed");
  expect((failedResult as any).error).toMatch(/nsfw/);

  const cancelledFetch = (async () => okJson({ status: "cancelled", error: "user cancelled" })) as unknown as typeof fetch;
  const cancelledResult = await (providerFor("gmicloud", cancelledFetch) as AsyncImageProvider).check("req-1", "k");
  expect(cancelledResult.state).toBe("failed");
  expect((cancelledResult as any).error).toMatch(/cancelled/);
});

it("gmi check throws ProviderAuthError on 401/403", async () => {
  const fetchFn = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn) as AsyncImageProvider;
  await expect(gmi.check("req-1", "bad-key")).rejects.toBeInstanceOf(ProviderAuthError);
});

it("gmi check downloads on success and enforces the mime/size guards", async () => {
  const fetchGood = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/requests/req-1")) return okJson({ status: "success", outcome: { media_urls: ["https://cdn.gmi/img.png"] } });
    if (u === "https://cdn.gmi/img.png") return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  const goodResult = await (providerFor("gmicloud", fetchGood) as AsyncImageProvider).check("req-1", "k");
  expect(goodResult.state).toBe("done");
  expect((goodResult as any).image.mime).toBe("image/png");
  expect(new Uint8Array((goodResult as any).image.bytes)).toEqual(new Uint8Array(PNG));

  const fetchBadMime = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/requests/req-1")) return okJson({ status: "success", outcome: { media_urls: ["https://cdn.gmi/img.png"] } });
    if (u === "https://cdn.gmi/img.png") return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  await expect((providerFor("gmicloud", fetchBadMime) as AsyncImageProvider).check("req-1", "k")).rejects.toThrow(/content type/);
});

it("gmi check rejects an image download over the size cap via Content-Length", async () => {
  const fetchFn = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/requests/req-1")) return okJson({ status: "success", outcome: { media_urls: ["https://cdn.gmi/img.png"] } });
    if (u === "https://cdn.gmi/img.png") {
      return new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(26 * 1024 * 1024) },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  await expect((providerFor("gmicloud", fetchFn) as AsyncImageProvider).check("req-1", "k")).rejects.toThrow(/too large/);
});

it("gmi check refuses to download a non-https or internal image url (SSRF guard), without fetching it", async () => {
  const make = (mediaUrl: string) => {
    const attempted: string[] = [];
    const fetchFn = (async (url: any) => {
      const u = String(url);
      attempted.push(u);
      if (u.endsWith("/requests/req-1")) return okJson({ status: "success", outcome: { media_urls: [mediaUrl] } });
      // Any attempt to actually fetch the guarded url is itself a failure.
      return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
    }) as unknown as typeof fetch;
    return { fetchFn, attempted };
  };

  for (const bad of ["http://cdn.gmi/img.png", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://127.0.0.1/x"]) {
    const { fetchFn, attempted } = make(bad);
    await expect((providerFor("gmicloud", fetchFn) as AsyncImageProvider).check("req-1", "k")).rejects.toThrow();
    expect(attempted).toEqual(["https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests/req-1"]); // never fetched the bad url
  }
});

it("unknown provider throws", () => {
  expect(() => providerFor("google")).toThrow(/unknown provider/);
});
