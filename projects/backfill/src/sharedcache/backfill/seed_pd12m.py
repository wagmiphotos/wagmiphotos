#!/usr/bin/env python3
"""Database seeding script for the PD12M (Public Domain 12 Million) dataset.

Fetches rows from the Hugging Face dataset-viewer, embeds the captions with
BGE, and inserts rows + vectors into D1 and Vectorize page by page.

Usage:
    uv run python -m sharedcache.backfill.seed_pd12m --limit 100
"""
import argparse
import logging
import sys
import uuid

from sharedcache.common.config import Settings
from sharedcache.common.models import AssetRecord

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
            id=asset_id, prompt=row["prompt"], url=row["url"], thumb_url=None, medium_url=None,
            model_used=None, source=source, source_id=str(row.get("id", n)),
            content_hash=f"{source}-{row.get('id', n)}", width=int(row.get("width", 0)),
            height=int(row.get("height", 0)), mime=row.get("mime", "image/jpeg"),
            manifest_url=None, created_at="", source_url=row["url"], locally_cached=False)
        d1.insert_asset(rec)
        batch.append({"id": asset_id, "values": list(row["embedding"]), "metadata": {"source": source}})
        n += 1
    if batch:
        vectorize.insert_many(batch)
    return n


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
        "width": int(row_data.get("width", 1024)),
        "height": int(row_data.get("height", 1024)),
        "mime": "image/jpeg",
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


def build_clients(settings: Settings) -> tuple:
    """Build (D1Client, VectorizeClient, BgeEmbedder) from Settings.

    Kept as a standalone helper (rather than inlined in main()) so tests can
    catch attribute-name/kwarg drift between Settings and the client
    constructors without needing to run the whole script.
    """
    from sharedcache.common.d1_client import D1Client
    from sharedcache.common.vectorize_client import VectorizeClient
    from sharedcache.common.bge import BgeEmbedder

    d1 = D1Client(
        account_id=settings.cf_account_id,
        database_id=settings.d1_database_id,
        api_token=settings.cf_api_token
    )

    vectorize = VectorizeClient(
        account_id=settings.cf_account_id,
        index_name=settings.vectorize_index_name,
        api_token=settings.cf_api_token,
        dims=settings.embedding_dims,
    )

    embedder = BgeEmbedder.from_pretrained(settings.bge_model_name)

    return d1, vectorize, embedder


def main() -> None:
    """Fetch PD12M rows+embeddings from HF and seed into D1/Vectorize."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Seed PD12M rows into D1 and Vectorize.")
    parser.add_argument("--repo-id", default=DEFAULT_HF_REPO_ID, help="HF Dataset Repository ID")
    parser.add_argument("--limit", type=int, default=5, help="Number of items to seed")
    args = parser.parse_args()

    settings = Settings()
    d1, vectorize, embedder = build_clients(settings)
    try:
        seeded = seed_from_hf(args.repo_id, args.limit, d1, vectorize, embedder,
                              hf_token=settings.hf_token)
    except Exception:
        logger.exception("seeding failed")
        sys.exit(1)
    print(f"Seeded {seeded} rows.")


if __name__ == "__main__":
    main()
