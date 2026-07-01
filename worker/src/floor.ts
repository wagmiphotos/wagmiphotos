export function similarityFloor(cacheTolerance: number, simMax = 0.35, simMin = 0.18): number {
  const t = Math.min(1, Math.max(0, cacheTolerance));
  return simMax - t * (simMax - simMin);
}
