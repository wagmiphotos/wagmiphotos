from dataclasses import dataclass
import httpx
from sharedcache.models import AssetRecord

@dataclass
class QueryRow:
    normalized_prompt: str
    original_prompt: str
    count: int

_API = "https://api.cloudflare.com/client/v4"

class D1Client:
    def __init__(self, account_id: str, database_id: str, api_token: str, timeout: float = 30.0):
        self._url = f"{_API}/accounts/{account_id}/d1/database/{database_id}/query"
        self._token = api_token
        self._timeout = timeout

    def _query(self, sql: str, params: list | None = None) -> list[dict]:
        with httpx.Client() as c:
            r = c.post(self._url, headers={"Authorization": f"Bearer {self._token}"},
                       json={"sql": sql, "params": params or []}, timeout=self._timeout)
        if r.status_code != 200:
            raise RuntimeError(f"D1 query failed ({r.status_code}): {r.text}")
        body = r.json()
        if not body.get("success", False):
            raise RuntimeError(f"D1 query error: {body.get('errors')}")
        return body["result"][0]["results"]

    def pending_queries(self, limit: int) -> list[QueryRow]:
        rows = self._query(
            "SELECT normalized_prompt, original_prompt, count FROM queries "
            "WHERE status='pending' ORDER BY count DESC LIMIT ?", [limit])
        return [QueryRow(r["normalized_prompt"], r["original_prompt"], int(r["count"])) for r in rows]

    def mark_query_built(self, normalized_prompt: str, asset_id: str) -> None:
        self._query("UPDATE queries SET status='built', last_asset_id=? WHERE normalized_prompt=?",
                    [asset_id, normalized_prompt])

    def insert_asset(self, rec: AssetRecord) -> None:
        self._query(
            "INSERT INTO assets (id, prompt, source, source_id, thumb_url, medium_url, url, "
            "model_used, content_hash, width, height, mime, source_url, locally_cached) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [rec.id, rec.prompt, rec.source, rec.source_id, rec.thumb_url, rec.medium_url, rec.url,
             rec.model_used, rec.content_hash, rec.width, rec.height, rec.mime, rec.source_url,
             1 if rec.locally_cached else 0])

    def assets_needing_rehost(self, limit: int) -> list[AssetRecord]:
        rows = self._query(
            "SELECT id, prompt, source, source_id, thumb_url, medium_url, url, model_used, "
            "content_hash, width, height, mime, source_url, locally_cached FROM assets "
            "WHERE locally_cached=0 LIMIT ?", [limit])
        return [AssetRecord(
            id=r["id"], prompt=r["prompt"], url=r["url"], thumb_url=r["thumb_url"],
            medium_url=r["medium_url"], model_used=r["model_used"], source=r["source"],
            source_id=r["source_id"], content_hash=r["content_hash"], width=r["width"],
            height=r["height"], mime=r["mime"], manifest_url=None, created_at="",
            source_url=r["source_url"], locally_cached=bool(r["locally_cached"])) for r in rows]

    def update_asset_urls(self, asset_id, *, url, medium_url, thumb_url, width, height, mime, locally_cached):
        self._query(
            "UPDATE assets SET url=?, medium_url=?, thumb_url=?, width=?, height=?, mime=?, "
            "locally_cached=? WHERE id=?",
            [url, medium_url, thumb_url, width, height, mime, 1 if locally_cached else 0, asset_id])
