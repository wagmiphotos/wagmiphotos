import { it, expect } from "vitest";
import { providerFor, ProviderAuthError } from "../src/providers";

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
  const img = await providerFor("openai", fetchFn).generate("a red fox", "sk-user");
  expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
  expect(calls[0].body).toEqual({ model: "gpt-image-2", prompt: "a red fox", n: 1, size: "1024x1024", quality: "medium", output_format: "webp", output_compression: 85, stream: true, partial_images: 1 });
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
  const img = await providerFor("openai", fetchFn).generate("a red fox", "sk-user");
  expect(new Uint8Array(img.bytes)).toEqual(new Uint8Array(PNG));
});

it("openai: stream ending without a completed event throws", async () => {
  const fetchFn = (async () => new Response(sseBody([
    { type: "image_generation.partial_image", b64: btoa("PARTIAL") },
  ]), { status: 200 })) as unknown as typeof fetch;
  await expect(providerFor("openai", fetchFn).generate("x", "sk-user"))
    .rejects.toThrow(/without a completed image/);
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

it("gmicloud: rejects a disallowed content type on the image download", async () => {
  const fetchFn = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/requests") && init?.method === "POST") return okJson({ request_id: "req-1" });
    if (u.endsWith("/requests/req-1")) {
      return okJson({ status: "success", outcome: { media_urls: [{ url: "https://cdn.gmi/img.png" }] } });
    }
    if (u === "https://cdn.gmi/img.png") return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn, async () => {});
  await expect(gmi.generate("a red fox", "gmi-key")).rejects.toThrow(/content type/);
});

it("gmicloud: rejects an image download over the size cap via Content-Length", async () => {
  const fetchFn = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/requests") && init?.method === "POST") return okJson({ request_id: "req-1" });
    if (u.endsWith("/requests/req-1")) {
      return okJson({ status: "success", outcome: { media_urls: [{ url: "https://cdn.gmi/img.png" }] } });
    }
    if (u === "https://cdn.gmi/img.png") {
      return new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(26 * 1024 * 1024) },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  const gmi = providerFor("gmicloud", fetchFn, async () => {});
  await expect(gmi.generate("a red fox", "gmi-key")).rejects.toThrow(/too large/);
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
