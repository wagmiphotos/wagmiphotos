import { it, expect } from "vitest";
import { providerFor, ProviderAuthError, type AsyncImageProvider, type SyncImageProvider } from "../src/providers";

// OpenAI is a sync provider; narrow the union once per stub the same way the
// GMI tests narrow to AsyncImageProvider below.
function openai(fetchFn: typeof fetch): SyncImageProvider {
  return providerFor("openai", fetchFn) as SyncImageProvider;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// SSE body shaped like the real stream (captured live 2026-07-09): partial
// first, completed last; only completed carries the final image.
const sseBody = (events: { type: string; b64?: string }[]) => events.map((e) =>
  `event: ${e.type}\ndata: ${JSON.stringify({ type: e.type, b64_json: e.b64, output_format: "webp" })}\n`
).join("\n") + "\n";

it("openai: posts the contract-pinned model with streaming and decodes the completed event", async () => {
  const calls: any[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), init });
    return new Response(sseBody([
      { type: "image_generation.partial_image", b64: btoa("PARTIAL") },
      { type: "image_generation.completed", b64: btoa("\x89PNG") },
    ]), { status: 200 });
  }) as unknown as typeof fetch;
  const img = await openai(fetchFn).generate("a red fox", "sk-user");
  expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
  expect(calls[0].body).toEqual({ model: "gpt-image-1", prompt: "a red fox", n: 1, size: "1024x1024", quality: "medium", output_format: "webp", output_compression: 85, stream: true, partial_images: 1 });
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  expect(img.mime).toBe("image/webp");
  expect(new Uint8Array(img.bytes)).toEqual(new Uint8Array(PNG)); // completed frame, not the partial
});

it("openai: parses CRLF-framed SSE (spec allows \\r\\n line endings)", async () => {
  const crlf = sseBody([
    { type: "image_generation.partial_image", b64: btoa("PARTIAL") },
    { type: "image_generation.completed", b64: btoa("\x89PNG") },
  ]).replace(/\n/g, "\r\n");
  const fetchFn = (async () => new Response(crlf, { status: 200 })) as unknown as typeof fetch;
  const img = await openai(fetchFn).generate("a red fox", "sk-user");
  expect(new Uint8Array(img.bytes)).toEqual(new Uint8Array(PNG));
});

it("openai: stream ending without a completed event throws", async () => {
  const fetchFn = (async () => new Response(sseBody([
    { type: "image_generation.partial_image", b64: btoa("PARTIAL") },
  ]), { status: 200 })) as unknown as typeof fetch;
  await expect(openai(fetchFn).generate("x", "sk-user"))
    .rejects.toThrow(/without a completed image/);
});

it("openai: 401 throws ProviderAuthError", async () => {
  const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await expect(openai(fetchFn).generate("x", "bad")).rejects.toBeInstanceOf(ProviderAuthError);
});

it("openai: validateKey pings /models", async () => {
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

it("unknown provider throws", () => {
  expect(() => providerFor("google")).toThrow(/unknown provider/);
});
