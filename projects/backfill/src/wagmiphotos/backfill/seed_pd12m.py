#!/usr/bin/env python3
"""Database seeding script for the PD12M (Public Domain 12 Million) dataset.

Reads rows from a local PD12M metadata download (--metadata-dir with the
dataset's *.parquet files) or from the Hugging Face dataset-viewer, embeds the
captions with BGE, and inserts rows + vectors into D1 and Vectorize page by
page.

Usage:
    uv run python -m wagmiphotos.backfill.seed_pd12m \
        --metadata-dir ~/data/PD12M/metadata --limit 1000
"""
import argparse
import logging
import sys
import time
import uuid
from pathlib import Path

from wagmiphotos.common.config import Settings
from wagmiphotos.common.models import AssetRecord

logger = logging.getLogger(__name__)

DEFAULT_HF_REPO_ID = "jorissup/PD12M-bucket"
HF_ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"
# The dataset-viewer /rows endpoint pages with offset+length; length caps at 100.
HF_MAX_PAGE_LENGTH = 100

SOURCE = "pd12m"


def seed_rows(rows, d1, vectorize, *, source=SOURCE) -> int:
    """Insert one chunk of rows into D1 and Vectorize (paired writes: at most
    one chunk can end up D1-only if the Vectorize insert fails).

    Args:
        rows: List of dicts with keys: id, prompt, url, width, height, mime, embedding
        d1: D1Client instance
        vectorize: VectorizeClient instance
        source: Source identifier (default "pd12m")

    Returns:
        Number of rows inserted
    """
    n = 0
    batch = []
    for row in rows:
        asset_id = str(uuid.uuid4())
        rec = AssetRecord(
            id=asset_id, prompt=row["prompt"], model_used=None, source=source,
            source_id=str(row.get("id", n)),
            content_hash=row.get("hash") or f"{source}-{row.get('id', n)}",
            width=int(row.get("width", 0)), height=int(row.get("height", 0)),
            mime=row.get("mime", "image/jpeg"), created_at="", source_url=row["url"],
            locally_cached=False)
        d1.insert_asset(rec)
        batch.append({"id": asset_id, "values": list(row["embedding"]), "metadata": {"source": source}})
        n += 1
    if batch:
        vectorize.insert_many(batch)
    return n


def seed_rows_bulk(rows, d1, vectorize, *, source=SOURCE) -> int:
    """Batched twin of seed_rows: D1 rows land in one chunked multi-row INSERT
    (insert_assets_many) and the vectors in one Vectorize batch, instead of one
    D1 round-trip per row. Same records/semantics as seed_rows."""
    recs = []
    batch = []
    for i, row in enumerate(rows):
        asset_id = str(uuid.uuid4())
        recs.append(AssetRecord(
            id=asset_id, prompt=row["prompt"], model_used=None, source=source,
            source_id=str(row.get("id", i)),
            content_hash=row.get("hash") or f"{source}-{row.get('id', i)}",
            width=int(row.get("width", 0)), height=int(row.get("height", 0)),
            mime=row.get("mime", "image/jpeg"), created_at="", source_url=row["url"],
            locally_cached=False))
        batch.append({"id": asset_id, "values": list(row["embedding"]),
                      "metadata": {"source": source}})
    if recs:
        # Vectorize FIRST: if it fails, D1 stays untouched and the page retries
        # cleanly. A crash can only ever leave an orphan VECTOR (id never lands
        # in D1), which the Worker tolerates — never an orphan D1 row that is
        # served from the library but invisible to similarity search.
        vectorize.insert_many(batch)
        d1.insert_assets_many(recs)
    return len(recs)


def fetch_hf_page(client, repo_id: str, offset: int, length: int, headers: dict) -> list[dict]:
    """Fetch one page from the HF dataset-viewer /rows endpoint."""
    resp = client.get(HF_ROWS_ENDPOINT,
                      params={"dataset": repo_id, "config": "default", "split": "train",
                              "offset": offset, "length": length},
                      headers=headers, timeout=15.0)
    if resp.status_code != 200:
        raise RuntimeError(
            f"HF rows request failed ({resp.status_code}) for {repo_id} offset={offset}")
    return resp.json().get("rows", [])


def _candidate(item: dict, fallback_id) -> dict | None:
    row_data = item.get("row", {})
    prompt = row_data.get("caption") or row_data.get("text")
    image_url = row_data.get("url") or row_data.get("image_url")
    if not (prompt and image_url):
        return None
    return {
        "id": str(row_data.get("id", item.get("row_idx", fallback_id))),
        "prompt": prompt, "url": image_url,
        "width": int(row_data.get("width") or 1024),
        "height": int(row_data.get("height") or 1024),
        "mime": row_data.get("mime_type") or "image/jpeg",
        "hash": row_data.get("hash"),
    }


def seed_from_hf(repo_id: str, limit: int, d1, vectorize, embedder, *,
                 hf_token: str | None = None, client=None, source: str = SOURCE) -> int:
    """Page through the HF dataset until `limit` rows are seeded (or the
    dataset runs out). Each page is deduped against D1 and written as one
    paired D1+Vectorize chunk."""
    import httpx

    headers = {"Authorization": f"Bearer {hf_token}"} if hf_token else {}
    own_client = client is None
    if own_client:
        client = httpx.Client()
    try:
        seeded = 0
        offset = 0
        while seeded < limit:
            length = min(limit - seeded, HF_MAX_PAGE_LENGTH)
            items = fetch_hf_page(client, repo_id, offset, length, headers)
            candidates = [c for i, item in enumerate(items)
                          if (c := _candidate(item, offset + i)) is not None]
            existing = d1.existing_source_ids(source, [c["id"] for c in candidates])
            fresh = [c for c in candidates if c["id"] not in existing]
            for c in fresh:
                c["embedding"] = embedder.text_embed(c["prompt"])  # BGE caption embedding
            if fresh:
                seeded += seed_rows(fresh, d1, vectorize, source=source)
            offset += len(items)
            if len(items) < length:
                break  # dataset exhausted
        return seeded
    finally:
        if own_client:
            client.close()


def iter_parquet_candidates(metadata_dir):
    """Yield candidate dicts from a local PD12M metadata download (the
    dataset's *.parquet files, read in sorted filename order). Streams in
    batches so the 12.5M-row full dataset never loads into memory at once."""
    import pyarrow.parquet as pq  # lazy: only the local seed path needs it

    files = sorted(Path(metadata_dir).glob("*.parquet"))
    if not files:
        raise RuntimeError(f"no .parquet files found in {metadata_dir}")
    fallback_id = 0
    for f in files:
        for batch in pq.ParquetFile(f).iter_batches(batch_size=1000):
            for row_data in batch.to_pylist():
                c = _candidate({"row": row_data}, fallback_id)
                fallback_id += 1
                if c is not None:
                    yield c


def _seed_candidate_page(page, d1, vectorize, embedder, *, source) -> int:
    """Dedupe one page against D1, embed the fresh captions, and write the
    paired D1+Vectorize chunk. Returns the number of rows actually seeded."""
    existing = d1.existing_source_ids(source, [c["id"] for c in page])
    fresh = [c for c in page if c["id"] not in existing]
    for c in fresh:
        c["embedding"] = embedder.text_embed(c["prompt"])  # BGE caption embedding
    return seed_rows(fresh, d1, vectorize, source=source) if fresh else 0


def seed_from_parquet(metadata_dir, limit: int, d1, vectorize, embedder, *,
                      source: str = SOURCE, page_size: int = HF_MAX_PAGE_LENGTH) -> int:
    """Seed up to `limit` rows from a local parquet metadata dir. Pages are
    deduped against D1, so re-runs skip already-seeded (source, source_id)s
    and keep reading until `limit` NEW rows land (or the data runs out)."""
    seeded = 0
    page: list[dict] = []
    for c in iter_parquet_candidates(metadata_dir):
        page.append(c)
        if len(page) >= min(page_size, limit - seeded):
            seeded += _seed_candidate_page(page, d1, vectorize, embedder, source=source)
            page = []
            if seeded >= limit:
                break
            logger.info("seeded %d/%d", seeded, limit)
    if page and seeded < limit:
        seeded += _seed_candidate_page(page, d1, vectorize, embedder, source=source)
    return seeded


def _seed_candidate_page_fast(page, d1, vectorize, embedder, *, source) -> int:
    """Batched twin of _seed_candidate_page: dedupe against D1, embed all fresh
    captions in ONE batched call, then write via seed_rows_bulk."""
    existing = d1.existing_source_ids(source, [c["id"] for c in page])
    fresh = [c for c in page if c["id"] not in existing]
    if not fresh:
        return 0
    embeddings = embedder.text_embed_many([c["prompt"] for c in fresh])
    for c, emb in zip(fresh, embeddings):
        c["embedding"] = emb
    return seed_rows_bulk(fresh, d1, vectorize, source=source)


def seed_from_parquet_fast(metadata_dir, limit: int, d1, vectorize, embedder, *,
                           source: str = SOURCE, page_size: int = 500,
                           skip: int = 0) -> int:
    """Batched twin of seed_from_parquet: same dedup-safe resume, but each page
    is embedded in one batched call and written with batched D1 + Vectorize
    inserts. ~1 HTTP round-trip per `page_size` rows instead of per row.

    `skip` fast-forwards past the first N parquet candidates locally, WITHOUT the
    per-page existing_source_ids dedup reads, so a top-up doesn't re-scan the whole
    already-seeded prefix (the dominant cost at scale). Purely a speed knob: every
    page that IS processed is still deduped, so skip can never seed a duplicate."""
    candidates = iter_parquet_candidates(metadata_dir)
    for _ in range(skip):
        if next(candidates, None) is None:
            break
    seeded = 0
    page: list[dict] = []
    for c in candidates:
        page.append(c)
        if len(page) >= min(page_size, limit - seeded):
            seeded += _seed_candidate_page_fast(page, d1, vectorize, embedder, source=source)
            page = []
            if seeded >= limit:
                break
            logger.info("seeded %d/%d", seeded, limit)
    if page and seeded < limit:
        seeded += _seed_candidate_page_fast(page, d1, vectorize, embedder, source=source)
    return seeded


def build_clients(settings: Settings) -> tuple:
    """Build (D1Client, VectorizeClient, BgeEmbedder) from Settings.

    Kept as a standalone helper (rather than inlined in main()) so tests can
    catch attribute-name/kwarg drift between Settings and the client
    constructors without needing to run the whole script.
    """
    from wagmiphotos.common.d1_client import D1Client
    from wagmiphotos.common.vectorize_client import VectorizeClient
    from wagmiphotos.common.bge import BgeEmbedder

    d1 = D1Client(
        account_id=settings.cf_account_id,
        database_id=settings.d1_database_id,
        api_token=settings.cf_api_token
    )

    vectorize = VectorizeClient(
        account_id=settings.cf_account_id,
        index_prefix=settings.vectorize_index_prefix,
        shards=settings.vectorize_shards,
        api_token=settings.cf_api_token,
        dims=settings.embedding_dims,
    )

    embedder = BgeEmbedder.from_pretrained(settings.bge_model_name)

    return d1, vectorize, embedder


def build_http_clients(settings: Settings) -> tuple:
    """Fresh (D1Client, VectorizeClient) — no BGE. Used to drop poisoned httpx
    connections between attempts (an SSL bad_record_mac poisons the reused pool),
    without paying the BGE reload the full build_clients would."""
    from wagmiphotos.common.d1_client import D1Client
    from wagmiphotos.common.vectorize_client import VectorizeClient

    d1 = D1Client(account_id=settings.cf_account_id, database_id=settings.d1_database_id,
                  api_token=settings.cf_api_token)
    vectorize = VectorizeClient(
        account_id=settings.cf_account_id, index_prefix=settings.vectorize_index_prefix,
        shards=settings.vectorize_shards, api_token=settings.cf_api_token,
        dims=settings.embedding_dims)
    return d1, vectorize


def build_embedder(settings: Settings):
    from wagmiphotos.common.bge import BgeEmbedder
    return BgeEmbedder.from_pretrained(settings.bge_model_name)


def pd12m_count(d1, source: str = SOURCE) -> int:
    return int(d1._query(
        "SELECT COUNT(*) AS c FROM assets WHERE source=?", [source])[0]["c"])


def seed_to_target(metadata_dir, target: int, clients, embedder, *, source: str = SOURCE,
                   count_fn=pd12m_count, page_size: int = 500, skip_margin: int = 5000,
                   max_stall: int = 8, cooldown_secs: float = 8.0,
                   sleep_fn=time.sleep, log_fn=None) -> int:
    """Resilient, overshoot-proof seed to an ABSOLUTE `source` count.

    `clients()` returns a fresh (d1, vectorize) pair; it is called once up front
    and again after every transient failure (an SSL bad_record_mac poisons the
    reused connection, so retrying on the same socket keeps failing). Each attempt
    recomputes `remaining` and `skip` from the live count, so it never overshoots
    the target and resumes cleanly after a crash. `skip` fast-forwards past the
    already-seeded parquet prefix (avoids the O(existing) dedup re-scan).

    Returns the final live count; raises RuntimeError if it makes no progress for
    `max_stall` consecutive attempts (parquet exhausted or a persistent failure).
    """
    log = log_fn or logger.info
    d1, vectorize = clients()
    stall = 0
    while True:
        current = count_fn(d1)
        if current >= target:
            return current
        remaining = target - current
        skip = max(0, current - skip_margin)
        log("seed_to_target: live=%d remaining=%d skip=%d stall=%d/%d",
            current, remaining, skip, stall, max_stall)
        try:
            seed_from_parquet_fast(metadata_dir, remaining, d1, vectorize, embedder,
                                   source=source, page_size=page_size, skip=skip)
        except Exception:
            logger.exception("transient failure; rebuilding clients and retrying")
            try:
                d1.close(); vectorize.close()
            except Exception:
                pass
            d1, vectorize = clients()
            sleep_fn(cooldown_secs)
        after = count_fn(d1)
        if after > current:
            stall = 0
        else:
            stall += 1
            if stall >= max_stall:
                raise RuntimeError(
                    f"seed_to_target stalled at {after} (target {target}) "
                    f"after {max_stall} attempts with no progress")


def main() -> None:
    """Seed PD12M rows into D1/Vectorize (local parquet, HF fallback, or the
    batched fast path). Routing:
      --metadata-dir --target N   -> seed_to_target (batched, resilient, to an
                                     absolute count; overshoot-proof + SSL-resilient)
      --metadata-dir --limit N --fast -> seed_from_parquet_fast (single batched pass)
      --metadata-dir --limit N    -> seed_from_parquet (slow, one D1 write per row)
      (no --metadata-dir)         -> seed_from_hf
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Seed PD12M rows into D1 and Vectorize.")
    parser.add_argument("--metadata-dir", type=Path, default=None,
                        help="Local PD12M metadata dir (*.parquet); preferred over HF")
    parser.add_argument("--repo-id", default=DEFAULT_HF_REPO_ID, help="HF Dataset Repository ID")
    parser.add_argument("--limit", type=int, default=5, help="Number of NEW items to seed")
    parser.add_argument("--target", type=int, default=None,
                        help="Absolute pd12m count to drive up to (implies the resilient "
                             "batched path); overshoot-proof, recomputes remaining each attempt")
    parser.add_argument("--fast", action="store_true",
                        help="Use the batched fast path (bulk D1 insert + batched embeds)")
    parser.add_argument("--page-size", type=int, default=500, help="Rows per batched page (fast)")
    parser.add_argument("--skip", type=int, default=0,
                        help="Fast-forward past the first N parquet candidates (fast, single pass)")
    args = parser.parse_args()

    settings = Settings()
    try:
        if args.metadata_dir is not None and args.target is not None:
            embedder = build_embedder(settings)
            final = seed_to_target(args.metadata_dir, args.target,
                                   lambda: build_http_clients(settings), embedder,
                                   page_size=args.page_size)
            print(f"Reached pd12m={final} (target {args.target}).")
            return
        d1, vectorize, embedder = build_clients(settings)
        if args.metadata_dir is not None and args.fast:
            seeded = seed_from_parquet_fast(args.metadata_dir, args.limit, d1, vectorize,
                                            embedder, page_size=args.page_size, skip=args.skip)
        elif args.metadata_dir is not None:
            seeded = seed_from_parquet(args.metadata_dir, args.limit, d1, vectorize, embedder)
        else:
            seeded = seed_from_hf(args.repo_id, args.limit, d1, vectorize, embedder,
                                  hf_token=settings.hf_token)
    except Exception:
        logger.exception("seeding failed")
        sys.exit(1)
    print(f"Seeded {seeded} rows.")


if __name__ == "__main__":
    main()
