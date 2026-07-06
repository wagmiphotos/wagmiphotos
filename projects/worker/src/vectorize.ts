import type { VectorizeStore, Match } from "./types";

export function makeVectorize(binding: VectorizeIndex): VectorizeStore {
  return {
    async query(vector, topK) {
      const res = await binding.query(vector, { topK });
      return (res.matches ?? []).map((m): Match => ({ id: m.id, score: m.score }));
    },
  };
}
