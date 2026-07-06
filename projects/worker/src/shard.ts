// FNV-1a 32-bit over UTF-8 bytes (contract.json: shard_fixtures pins parity
// with the Python implementation in wagmiphotos.common.shard).
export function fnv1a32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5; // 2166136261
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0; // * 16777619, unsigned wraparound
  }
  return h >>> 0;
}

export function shardFor(id: string, shards: number): number {
  return fnv1a32(id) % shards;
}
