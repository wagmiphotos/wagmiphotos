import type { VectorizeStore, Match } from "./types";

// One logical store over N shard indexes: queries fan out to every shard and
// merge by score (cosine scores from identically-configured indexes are
// directly comparable). Writes are routed by fnv1a32(id) — backfill-side only.
export function makeVectorize(bindings: VectorizeIndex[]): VectorizeStore {
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
  };
}
