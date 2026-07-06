import json

import httpx

from sharedcache.common.cf_api import API_BASE, post_with_retry

DEFAULT_EMBEDDING_DIMS = 768


class VectorizeClient:
    def __init__(self, account_id: str, index_name: str, api_token: str,
                 timeout: float = 30.0, dims: int = DEFAULT_EMBEDDING_DIMS):
        self._base = f"{API_BASE}/accounts/{account_id}/vectorize/v2/indexes/{index_name}"
        self._index = index_name
        self._dims = dims
        self._client = httpx.Client(timeout=timeout)
        self._token = api_token

    def close(self) -> None:
        self._client.close()

    def _headers(self, content_type: str = "application/json") -> dict:
        return {"Authorization": f"Bearer {self._token}", "Content-Type": content_type}

    def _validate_dims(self, values: list[float], id: str) -> None:
        if len(values) != self._dims:
            raise ValueError(
                f"vector {id!r} has length {len(values)} but index {self._index!r} "
                f"expects embedding_dims={self._dims}")

    def query(self, values: list[float], top_k: int = 1) -> list[dict]:
        body = post_with_retry(
            self._client, f"{self._base}/query", what="Vectorize query",
            headers=self._headers(),
            json={"vector": values, "topK": top_k, "returnMetadata": "none"})
        return body["result"]["matches"]

    def _ndjson(self, path: str, vectors: list[dict]) -> None:
        for v in vectors:
            self._validate_dims(v["values"], v.get("id", "?"))
        content = "\n".join(json.dumps(v) for v in vectors).encode()
        post_with_retry(self._client, f"{self._base}/{path}", what=f"Vectorize {path}",
                        headers=self._headers("application/x-ndjson"), content=content)

    def upsert(self, id: str, values: list[float], metadata: dict) -> None:
        self._ndjson("upsert", [{"id": id, "values": values, "metadata": metadata}])

    def insert_many(self, vectors: list[dict]) -> None:
        self._ndjson("insert", vectors)
