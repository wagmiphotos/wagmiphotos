import json

import httpx

from wagmiphotos.common.cf_api import API_BASE, post_with_retry
from wagmiphotos.common.shard import shard_for

DEFAULT_EMBEDDING_DIMS = 768


class VectorizeClient:
    """Vectorize is sharded into `shards` indexes named `{index_prefix}{n}`
    (n = 0..shards-1). Writes route to exactly one shard by `shard_for(id,
    shards)`; queries fan out to every shard and merge results by max score,
    since a match can only ever exist in the one shard its id hashes to, but
    the caller doesn't know which shard that is ahead of a query."""

    def __init__(self, account_id: str, index_prefix: str, shards: int, api_token: str,
                 timeout: float = 30.0, dims: int = DEFAULT_EMBEDDING_DIMS):
        self._account_id = account_id
        self._prefix = index_prefix
        self._shards = int(shards)
        self._dims = dims
        self._client = httpx.Client(timeout=timeout)
        self._token = api_token

    def close(self) -> None:
        self._client.close()

    def _headers(self, content_type: str = "application/json") -> dict:
        return {"Authorization": f"Bearer {self._token}", "Content-Type": content_type}

    def _index_base(self, shard: int) -> str:
        return f"{API_BASE}/accounts/{self._account_id}/vectorize/v2/indexes/{self._prefix}{shard}"

    def _validate_dims(self, values: list[float], id: str) -> None:
        if len(values) != self._dims:
            raise ValueError(
                f"vector {id!r} has length {len(values)} but index prefix {self._prefix!r} "
                f"expects embedding_dims={self._dims}")

    def _query_one(self, shard: int, values: list[float], top_k: int) -> list[dict]:
        body = post_with_retry(
            self._client, f"{self._index_base(shard)}/query", what="Vectorize query",
            headers=self._headers(),
            json={"vector": values, "topK": top_k, "returnMetadata": "none"})
        return body["result"]["matches"]

    def query(self, values: list[float], top_k: int = 1) -> list[dict]:
        """Fan out to every shard (each queried for the full top_k, since the
        best matches for this vector could all live in one shard), then merge
        by keeping the max score seen per id, sort desc, and slice to top_k."""
        best: dict[str, float] = {}
        for shard in range(self._shards):
            for m in self._query_one(shard, values, top_k):
                if m["id"] not in best or m["score"] > best[m["id"]]:
                    best[m["id"]] = m["score"]
        merged = sorted(({"id": i, "score": s} for i, s in best.items()),
                        key=lambda m: m["score"], reverse=True)
        return merged[:top_k]

    def _post_ndjson(self, shard: int, path: str, vectors: list[dict]) -> None:
        content = "\n".join(json.dumps(v) for v in vectors).encode()
        post_with_retry(self._client, f"{self._index_base(shard)}/{path}", what=f"Vectorize {path}",
                        headers=self._headers("application/x-ndjson"), content=content)

    def upsert(self, id: str, values: list[float], metadata: dict) -> None:
        self._validate_dims(values, id)
        shard = shard_for(id, self._shards)
        self._post_ndjson(shard, "upsert", [{"id": id, "values": values, "metadata": metadata}])

    def insert_many(self, vectors: list[dict]) -> None:
        # Validate everything up front so a bad vector anywhere in the batch
        # rejects before any shard's REST call goes out (no partial writes).
        for v in vectors:
            self._validate_dims(v["values"], v.get("id", "?"))
        by_shard: dict[int, list[dict]] = {}
        for v in vectors:
            by_shard.setdefault(shard_for(v["id"], self._shards), []).append(v)
        for shard in sorted(by_shard):
            self._post_ndjson(shard, "insert", by_shard[shard])

    def delete(self, ids: list[str]) -> None:
        """Delete vectors by id, routed to each id's shard (best-effort cleanup
        for tombstoned assets — the Worker tolerates orphan vectors)."""
        by_shard: dict[int, list[str]] = {}
        for id in ids:
            by_shard.setdefault(shard_for(id, self._shards), []).append(id)
        for shard in sorted(by_shard):
            post_with_retry(self._client, f"{self._index_base(shard)}/delete_by_ids",
                            what="Vectorize delete_by_ids", headers=self._headers(),
                            json={"ids": by_shard[shard]})
