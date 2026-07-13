// Similarity floor bounds (contract.json: floor_sim_max / floor_sim_min).
// Single TS source of truth; test/contract.test.ts pins them to the contract.
// 2026-07-14: max 0.87 -> 0.84 after the library grew to ~61.5k. Vectorize's ANN
// index compresses scores at scale (verbatim self-match fell 1.00 -> ~0.89 on the
// probe), so real hits (queries for images that ARE in the pool, ~0.84-0.88) were
// dropping below the old effective floor and getting mislabeled "approximate".
export const FLOOR_SIM_MAX = 0.84;
export const FLOOR_SIM_MIN = 0.75;

export function similarityFloor(cacheTolerance: number, simMax = FLOOR_SIM_MAX, simMin = FLOOR_SIM_MIN): number {
  const t = Math.min(1, Math.max(0, cacheTolerance));
  return simMax - t * (simMax - simMin);
}
