import { it, expect } from "vitest";
import { moderationFlagged, MODERATIONS_URL } from "../src/moderation";

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

it("returns null when not flagged", async () => {
  const fetchFn = (async (url: any, init: any) => {
    expect(String(url)).toBe(MODERATIONS_URL);
    expect(init.headers.Authorization).toBe("Bearer sk-mod");
    expect(JSON.parse(init.body).model).toBe("omni-moderation-latest");
    return okJson({ results: [{ flagged: false, categories: {} }] });
  }) as unknown as typeof fetch;
  expect(await moderationFlagged("a red fox", "sk-mod", fetchFn)).toBeNull();
});

it("returns the first flagged category", async () => {
  const fetchFn = (async () =>
    okJson({ results: [{ flagged: true, categories: { violence: false, sexual: true } }] })
  ) as unknown as typeof fetch;
  expect(await moderationFlagged("bad", "sk-mod", fetchFn)).toBe("sexual");
});

it("returns 'flagged' when flagged with no category detail", async () => {
  const fetchFn = (async () => okJson({ results: [{ flagged: true, categories: {} }] })) as unknown as typeof fetch;
  expect(await moderationFlagged("bad", "sk-mod", fetchFn)).toBe("flagged");
});

it("throws on non-2xx (caller fails closed)", async () => {
  const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await expect(moderationFlagged("x", "sk-mod", fetchFn)).rejects.toThrow(/moderation 500/);
});
