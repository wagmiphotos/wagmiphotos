from typing import Protocol
import numpy as np
from sharedcache.models import AssetRecord

class CacheIndex(Protocol):
    def search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]: ...
    def insert(self, record: AssetRecord, embedding: list[float]) -> None: ...

def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))

class InMemoryCacheIndex:
    def __init__(self) -> None:
        self._rows: list[tuple[AssetRecord, np.ndarray]] = []

    def insert(self, record: AssetRecord, embedding: list[float]) -> None:
        self._rows.append((record, np.asarray(embedding, dtype=float)))

    def search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]:
        q = np.asarray(embedding, dtype=float)
        scored = [(rec, _cosine(q, vec)) for rec, vec in self._rows]
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:k]


import json
import psycopg
from pgvector.psycopg import register_vector

class PgCacheIndex:
    def __init__(self, dsn: str, dims: int = 768):
        self._dsn = dsn
        self._dims = dims

    def _conn(self):
        conn = psycopg.connect(self._dsn)
        register_vector(conn)
        return conn

    def insert(self, record: AssetRecord, embedding: list[float]) -> None:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO assets (id, prompt, url, thumb_url, provider, model,
                       content_hash, width, height, mime, manifest_url, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (record.id, record.prompt, record.url, record.thumb_url, record.provider,
                 record.model, record.content_hash, record.width, record.height,
                 record.mime, record.manifest_url, np.asarray(embedding, dtype=float)),
            )
            conn.commit()

    def search(self, embedding: list[float], k: int = 5) -> list[tuple[AssetRecord, float]]:
        q = np.asarray(embedding, dtype=float)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, prompt, url, thumb_url, provider, model, content_hash,
                          width, height, mime, manifest_url, created_at,
                          1 - (embedding <=> %s) AS similarity
                   FROM assets ORDER BY embedding <=> %s LIMIT %s""",
                (q, q, k),
            )
            out = []
            for row in cur.fetchall():
                rec = AssetRecord(id=str(row[0]), prompt=row[1], url=row[2], thumb_url=row[3],
                                  provider=row[4], model=row[5], content_hash=row[6],
                                  width=row[7], height=row[8], mime=row[9], manifest_url=row[10],
                                  created_at=row[11].isoformat())
                out.append((rec, float(row[12])))
            return out
