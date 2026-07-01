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
