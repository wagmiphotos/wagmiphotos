// Similarity floor bounds (contract.json: floor_sim_max / floor_sim_min).
// Single TS source of truth; test/contract.test.ts pins them to the contract.
export const FLOOR_SIM_MAX = 0.90;
export const FLOOR_SIM_MIN = 0.72;

export function similarityFloor(cacheTolerance: number, simMax = FLOOR_SIM_MAX, simMin = FLOOR_SIM_MIN): number {
  const t = Math.min(1, Math.max(0, cacheTolerance));
  return simMax - t * (simMax - simMin);
}
