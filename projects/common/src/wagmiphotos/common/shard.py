"""FNV-1a 32-bit over UTF-8 bytes. Parity with projects/worker/src/shard.ts
is pinned by contract.json shard_fixtures on both test suites."""


def fnv1a32(s: str) -> int:
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def shard_for(asset_id: str, shards: int) -> int:
    return fnv1a32(asset_id) % shards
