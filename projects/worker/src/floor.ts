export function similarityFloor(cacheTolerance: number, simMax = 0.90, simMin = 0.72): number {
  const t = Math.min(1, Math.max(0, cacheTolerance));
  return simMax - t * (simMax - simMin);
}
