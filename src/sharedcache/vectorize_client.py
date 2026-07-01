import json
import httpx

_API = "https://api.cloudflare.com/client/v4"

class VectorizeClient:
    def __init__(self, account_id: str, index_name: str, api_token: str, timeout: float = 30.0):
        self._base = f"{_API}/accounts/{account_id}/vectorize/v2/indexes/{index_name}"
        self._token = api_token
        self._timeout = timeout

    def _headers(self, content_type: str = "application/json") -> dict:
        return {"Authorization": f"Bearer {self._token}", "Content-Type": content_type}

    def query(self, values: list[float], top_k: int = 1) -> list[dict]:
        with httpx.Client() as c:
            r = c.post(f"{self._base}/query", headers=self._headers(),
                       json={"vector": values, "topK": top_k, "returnMetadata": "all"},
                       timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"Vectorize query failed ({r.status_code}): {r.text}")
        body = r.json()
        if not body.get("success", False):
            raise RuntimeError(f"Vectorize query error: {body.get('errors')}")
        return body["result"]["matches"]

    def _ndjson(self, path: str, vectors: list[dict]) -> None:
        body = "\n".join(json.dumps(v) for v in vectors).encode()
        with httpx.Client() as c:
            r = c.post(f"{self._base}/{path}", headers=self._headers("application/x-ndjson"),
                       content=body, timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"Vectorize {path} failed ({r.status_code}): {r.text}")
        body = r.json()
        if not body.get("success", False):
            raise RuntimeError(f"Vectorize {path} error: {body.get('errors')}")

    def upsert(self, id: str, values: list[float], metadata: dict) -> None:
        self._ndjson("upsert", [{"id": id, "values": values, "metadata": metadata}])

    def insert_many(self, vectors: list[dict]) -> None:
        self._ndjson("insert", vectors)
