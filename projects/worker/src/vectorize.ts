import type { VectorizeStore, Match } from "./types";
import { shardFor } from "./shard";

// One logical store over N shard indexes: queries fan out to every shard and
// merge by score (cosine scores from identically-configured indexes are
// directly comparable). Writes are routed by fnv1a32(id) — backfill-side only.
// The optional `coll` binding is a namespaced index (namespace = collection
// id) for collection-scoped assets, dual-written alongside the shards. When
// absent (local dev, some tests), namespace-scoped operations degrade
// gracefully: queryNamespace returns [], upsertNamespace/deleteByIds skip it.
export function makeVectorize(bindings: VectorizeIndex[], coll?: VectorizeIndex): VectorizeStore {
  return {
    async query(vector, topK) {
      const results = await Promise.all(bindings.map((b) => b.query(vector, { topK })));
      const best = new Map<string, number>();
      for (const r of results) {
        for (const m of r.matches ?? []) {
          const prev = best.get(m.id);
          if (prev == null || m.score > prev) best.set(m.id, m.score);
        }
      }
      return [...best.entries()]
        .map(([id, score]): Match => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    async upsert(id, vector) {
      await bindings[shardFor(id, bindings.length)].upsert([{ id, values: vector }]);
    },
    async queryNamespace(vector, namespace, topK) {
      if (!coll) return []; // unbound in local dev: scoped search degrades to a miss
      const r = await coll.query(vector, { topK, namespace });
      return (r.matches ?? []).map((m): Match => ({ id: m.id, score: m.score }));
    },
    async upsertNamespace(id, vector, namespace) {
      if (!coll) return;
      await coll.upsert([{ id, values: vector, namespace }]);
    },
    async deleteByIds(ids) {
      if (ids.length === 0) return;
      const byShard = new Map<number, string[]>();
      for (const id of ids) {
        const s = shardFor(id, bindings.length);
        byShard.set(s, [...(byShard.get(s) ?? []), id]);
      }
      await Promise.all([
        ...[...byShard.entries()].map(([s, list]) => bindings[s].deleteByIds(list)),
        ...(coll ? [coll.deleteByIds(ids)] : []),
      ]);
    },
  };
}
