#!/usr/bin/env python3
"""Reconcile pd12m rows that are in D1 but missing from Vectorize.

Such orphans are created by the D1-first seed path (`seed_rows`) when a Vectorize
insert hits a transient SSL error AFTER the page's D1 rows have already landed:
dedup then skips them on resume, so their vectors are never written. They are
served from the library but invisible to similarity search. (The batched fast
path writes Vectorize-first, so it does not create these.)

This scans every pd12m row, checks the vector index with get_by_ids, and backfills
the missing vectors (plain insert — orphans don't exist in Vectorize yet). It is
idempotent and resumable: re-running only re-checks and fills what is still missing.

Run:  python -m wagmiphotos.backfill.reconcile_orphans          # dry-run (count only)
      python -m wagmiphotos.backfill.reconcile_orphans --apply  # backfill
"""
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor

from wagmiphotos.common.config import Settings
from wagmiphotos.common.cf_api import API_BASE
from wagmiphotos.common.shard import shard_for

logger = logging.getLogger(__name__)

SOURCE = "pd12m"
GET_BY_IDS_MAX = 20   # Vectorize get_by_ids hard cap (400 code 40007 above this)
WORKERS = 12          # concurrent get_by_ids checks (httpx.Client is thread-safe)
PAGE = 4000           # D1 rows scanned per keyset page


def plan_shard_chunks(ids, shards, batch=GET_BY_IDS_MAX):
    """Group `ids` by Vectorize shard and chunk each group to the get_by_ids cap.
    Returns [(shard, [ids...]), ...]. Pure."""
    by_shard: dict[int, list[str]] = {}
    for i in ids:
        by_shard.setdefault(shard_for(i, shards), []).append(i)
    chunks = []
    for shard, sids in by_shard.items():
        for j in range(0, len(sids), batch):
            chunks.append((shard, sids[j:j + batch]))
    return chunks


def existing_ids(check_fn, ids, shards, mapper=map):
    """Which of `ids` already have a vector. `check_fn(shard, chunk) -> set` runs
    one get_by_ids call; injected (and `mapper` overridable with a pool.map) so the
    grouping/aggregation is testable without network."""
    found: set[str] = set()
    for res in mapper(lambda t: check_fn(t[0], t[1]), plan_shard_chunks(ids, shards)):
        found |= res
    return found


def http_check_fn(cli, settings):
    def check(shard, chunk):
        base = (f"{API_BASE}/accounts/{settings.cf_account_id}/vectorize/v2/"
                f"indexes/{settings.vectorize_index_prefix}{shard}/get_by_ids")
        for attempt in range(5):
            try:
                r = cli.post(base, headers={"Authorization": f"Bearer {settings.cf_api_token}",
                                            "Content-Type": "application/json"},
                             json={"ids": chunk}, timeout=30)
                r.raise_for_status()
                return {v["id"] for v in r.json().get("result", [])}
            except Exception as e:
                if attempt == 4:
                    raise
                logger.warning("get_by_ids retry (%s)", e)
    return check


def main() -> int:
    import httpx
    from wagmiphotos.common.d1_client import D1Client
    from wagmiphotos.common.vectorize_client import VectorizeClient
    from wagmiphotos.common.bge import BgeEmbedder

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)   # one summary line/page
    ap = argparse.ArgumentParser(description="Backfill vectors for pd12m rows missing from Vectorize.")
    ap.add_argument("--apply", action="store_true",
                    help="backfill missing vectors (default: dry-run, count only)")
    args = ap.parse_args()

    s = Settings()
    d1 = D1Client(account_id=s.cf_account_id, database_id=s.d1_database_id, api_token=s.cf_api_token)
    vectorize = VectorizeClient(
        account_id=s.cf_account_id, index_prefix=s.vectorize_index_prefix,
        shards=s.vectorize_shards, api_token=s.cf_api_token, dims=s.embedding_dims)
    embedder = BgeEmbedder.from_pretrained(s.bge_model_name) if args.apply else None
    cli = httpx.Client(timeout=30, limits=httpx.Limits(max_connections=WORKERS * 2))
    check = http_check_fn(cli, s)

    total = fixed = orphans = 0
    last_id = ""
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while True:
            rows = d1._query(
                "SELECT id, prompt FROM assets WHERE source=? AND id > ? ORDER BY id LIMIT ?",
                [SOURCE, last_id, PAGE])
            if not rows:
                break
            last_id = rows[-1]["id"]
            total += len(rows)
            have = existing_ids(check, [r["id"] for r in rows], s.vectorize_shards, mapper=pool.map)
            missing = [r for r in rows if r["id"] not in have]
            orphans += len(missing)
            if missing and args.apply:
                embs = embedder.text_embed_many([r["prompt"] for r in missing])
                vectorize.insert_many([{"id": r["id"], "values": list(e),
                                        "metadata": {"source": SOURCE}}
                                       for r, e in zip(missing, embs)])
                fixed += len(missing)
            logger.info("scanned=%d orphans=%d fixed=%d (last_id=%s)",
                        total, orphans, fixed, last_id[:8])

    logger.info("DONE: scanned=%d orphans_found=%d fixed=%d apply=%s",
                total, orphans, fixed, args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
