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
  it("upsert routes to the fnv1a32(id) % shards binding", async () => {
    const upserts: { shard: number; rows: any[] }[] = [];
    const mk = (shard: number): any => ({
      query: async () => ({ matches: [] }),
      upsert: async (rows: any[]) => { upserts.push({ shard, rows }); },
    });
    const store = makeVectorize([mk(0), mk(1), mk(2)]);
    // contract.json shard_fixtures pins "demo-3" -> shard 1
    await store.upsert("demo-3", [0.1, 0.2]);
    expect(upserts).toEqual([{ shard: 1, rows: [{ id: "demo-3", values: [0.1, 0.2] }] }]);
  });

  it("queryNamespace queries only the collections index with the namespace option", async () => {
    const calls: any[] = [];
    const shard = { query: async () => ({ matches: [] }), upsert: async () => {}, deleteByIds: async () => {} };
    const coll: any = {
      query: async (v: number[], opts: any) => { calls.push(opts); return { matches: [{ id: "a1", score: 0.9 }] }; },
      upsert: async () => {}, deleteByIds: async () => {},
    };
    const store = makeVectorize([shard, shard, shard] as any, coll);
    const got = await store.queryNamespace([0.1], "col_abc", 3);
    expect(got).toEqual([{ id: "a1", score: 0.9 }]);
    expect(calls[0]).toEqual({ topK: 3, namespace: "col_abc" });
  });

  it("queryNamespace returns [] when no collections binding (local dev degrade)", async () => {
    const shard = { query: async () => ({ matches: [] }), upsert: async () => {} };
    const store = makeVectorize([shard, shard, shard] as any);
    expect(await store.queryNamespace([0.1], "col_abc", 3)).toEqual([]);
  });

  it("upsertNamespace writes the vector with a namespace to the collections index", async () => {
    const written: any[] = [];
    const shard = { query: async () => ({ matches: [] }), upsert: async () => {} };
    const coll: any = { upsert: async (vs: any[]) => written.push(...vs) };
    const store = makeVectorize([shard, shard, shard] as any, coll);
    await store.upsertNamespace("a1", [0.1, 0.2], "col_abc");
    expect(written).toEqual([{ id: "a1", values: [0.1, 0.2], namespace: "col_abc" }]);
  });

  it("deleteByIds routes each id to its fnv1a32 shard and always the collections index", async () => {
    const perShard: string[][] = [[], [], []];
    const collDeleted: string[] = [];
    const mkShard = (i: number): any => ({ query: async () => ({ matches: [] }), upsert: async () => {}, deleteByIds: async (ids: string[]) => perShard[i].push(...ids) });
    const coll: any = { deleteByIds: async (ids: string[]) => collDeleted.push(...ids) };
    const store = makeVectorize([mkShard(0), mkShard(1), mkShard(2)], coll);
    // contract.json shard_fixtures: demo-1 -> 0, demo-3 -> 1, pd12m-8492731 -> 2
    await store.deleteByIds(["demo-1", "demo-3", "pd12m-8492731"]);
    expect(perShard[0]).toEqual(["demo-1"]);
    expect(perShard[1]).toEqual(["demo-3"]);
    expect(perShard[2]).toEqual(["pd12m-8492731"]);
    expect(collDeleted.sort()).toEqual(["demo-1", "demo-3", "pd12m-8492731"]);
  });

  it("deleteByIds with no ids is a no-op", async () => {
    const store = makeVectorize([{ query: async () => ({ matches: [] }), upsert: async () => {} }] as any);
    await store.deleteByIds([]); // must not throw
  });
});
