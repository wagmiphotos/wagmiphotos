import { describe, it, expect } from "vitest";
import { makeVectorize } from "../src/vectorize";

const shard = (matches: { id: string; score: number }[]) =>
  ({ query: async (_v: number[], _o: any) => ({ matches }) }) as any;

describe("makeVectorize (sharded)", () => {
  it("fans out to every shard and merges by score desc", async () => {
    const store = makeVectorize([
      shard([{ id: "a", score: 0.91 }, { id: "b", score: 0.5 }]),
      shard([{ id: "c", score: 0.95 }]),
      shard([{ id: "d", score: 0.8 }]),
    ]);
    const out = await store.query([0.1], 3);
    expect(out.map((m) => m.id)).toEqual(["c", "a", "d"]);
  });
  it("dedupes ids keeping the higher score, even when the higher score comes from the earlier shard", async () => {
    // The higher score (0.9) arrives from shard 0 (earlier); the lower score
    // (0.7) arrives from shard 1 (later). A last-write-wins merge would
    // wrongly clobber 0.9 with 0.7; max-score merge must keep 0.9.
    const store = makeVectorize([shard([{ id: "a", score: 0.9 }]), shard([{ id: "a", score: 0.7 }])]);
    const out = await store.query([0.1], 5);
    expect(out).toEqual([{ id: "a", score: 0.9 }]);
  });
  it("tolerates a shard returning no matches field", async () => {
    const store = makeVectorize([({ query: async () => ({}) }) as any, shard([{ id: "x", score: 0.6 }])]);
    expect(await store.query([0.1], 2)).toEqual([{ id: "x", score: 0.6 }]);
  });
});
