import { it, expect, vi } from "vitest";
import { bgeTextEmbed } from "../src/embed";

function fakeEnv(vec: number[]) {
  return { AI: { run: vi.fn(async () => ({ shape: [1, vec.length], data: [vec] })) } } as any;
}

it("bgeTextEmbed calls the bge model and returns the vector", async () => {
  const env = fakeEnv([3, 4]); // un-normalized on purpose
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const v = await bgeTextEmbed("a red fox", env);
  expect(env.AI.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: "a red fox" });
  expect(fetchSpy).not.toHaveBeenCalled();          // no external embed call
  // L2-normalized: [3,4] -> [0.6, 0.8]
  expect(v[0]).toBeCloseTo(0.6, 5);
  expect(v[1]).toBeCloseTo(0.8, 5);
  vi.unstubAllGlobals();
});

it("bgeTextEmbed throws on an unexpected response", async () => {
  const env = { AI: { run: async () => ({ data: null }) } } as any;
  await expect(bgeTextEmbed("x", env)).rejects.toThrow(/Unexpected/);
});
