#!/usr/bin/env python3
"""Database seeding script for the PD12M (Public Domain 12 Million) dataset.

Inserts PD12M rows and their precomputed embeddings into D1 and Vectorize.

Usage:
    uv run python scripts/seed_pd12m.py --limit 100
"""
import argparse
import uuid
from sharedcache.config import Settings
from sharedcache.models import AssetRecord


def seed_rows(rows, d1, vectorize, *, source="pd12m") -> int:
    """Insert rows into D1 and Vectorize.

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
            model_used="clip-vit-l-14", source=source, source_id=str(row.get("id", n)),
            content_hash=f"{source}-{row.get('id', n)}", width=int(row.get("width", 0)),
            height=int(row.get("height", 0)), mime=row.get("mime", "image/jpeg"),
            manifest_url=None, created_at="", source_url=row["url"], locally_cached=False)
        d1.insert_asset(rec)
        batch.append({"id": asset_id, "values": list(row["embedding"]), "metadata": {"source": source}})
        n += 1
    if batch:
        vectorize.insert_many(batch)
    return n


def build_clients(settings: Settings) -> tuple:
    """Build (D1Client, VectorizeClient, ClipEmbedder) from Settings.

    Kept as a standalone helper (rather than inlined in main()) so tests can
    catch attribute-name/kwarg drift between Settings and the client
    constructors without needing to run the whole script.
    """
    from sharedcache.d1_client import D1Client
    from sharedcache.vectorize_client import VectorizeClient
    from sharedcache.clip import ClipEmbedder

    d1 = D1Client(
        account_id=settings.cf_account_id,
        database_id=settings.d1_database_id,
        api_token=settings.cf_api_token
    )

    vectorize = VectorizeClient(
        account_id=settings.cf_account_id,
        index_name=settings.vectorize_index_name,
        api_token=settings.cf_api_token
    )

    clip = ClipEmbedder(
        settings.clip_text_embed_url,
        settings.clip_image_embed_url,
        token=settings.clip_embed_token
    )

    return d1, vectorize, clip


def main() -> None:
    """Fetch PD12M rows+embeddings from HF and seed into D1/Vectorize."""
    import httpx

    parser = argparse.ArgumentParser(description="Seed PD12M rows into D1 and Vectorize.")
    parser.add_argument("--repo-id", default="jorissup/PD12M-bucket", help="HF Dataset Repository ID")
    parser.add_argument("--limit", type=int, default=5, help="Number of items to seed")
    args = parser.parse_args()

    settings = Settings()
    d1, vectorize, clip = build_clients(settings)

    # Fetch rows from HF Dataset Server
    rows = []
    try:
        headers = {}
        if settings.hf_token:
            headers["Authorization"] = f"Bearer {settings.hf_token}"

        url = f"https://datasets-server.huggingface.co/rows?dataset={args.repo_id}&config=default&split=train&offset=0&limit={args.limit}"
        print(f"Fetching from: {url}")

        resp = httpx.get(url, headers=headers, timeout=15.0)
        if resp.status_code == 200:
            data = resp.json()
            for item in data.get("rows", []):
                row_data = item.get("row", {})
                prompt = row_data.get("caption") or row_data.get("text")
                image_url = row_data.get("url") or row_data.get("image_url")
                width = int(row_data.get("width", 1024))
                height = int(row_data.get("height", 1024))

                if prompt and image_url:
                    # Check if row has precomputed embedding. PD12M ships CLIP IMAGE
                    # vectors, so any fallback must also embed in image space — never
                    # text-embed here, or we'd mix text-space vectors into an
                    # image-space index and corrupt the similarity-floor calibration
                    # (text<->text cosines ~0.6-0.9 vs image cross-modal ~0.25-0.35).
                    precomputed_embedding = row_data.get("embedding")
                    if precomputed_embedding and len(precomputed_embedding) > 0:
                        embedding = precomputed_embedding
                        print(f"[{row_data.get('id', len(rows))}] embedding: precomputed")
                    elif settings.clip_image_embed_url:
                        img_resp = httpx.get(image_url, follow_redirects=True, timeout=20.0)
                        if img_resp.status_code != 200:
                            raise RuntimeError(
                                f"Failed to download image for embedding ({img_resp.status_code}): {image_url}")
                        embedding = clip.image_embed(img_resp.content)
                        print(f"[{row_data.get('id', len(rows))}] embedding: image-embedded via CLIP_IMAGE_EMBED_URL")
                    else:
                        raise RuntimeError(
                            "PD12M rows lack precomputed embeddings and CLIP_IMAGE_EMBED_URL is unset — "
                            "set it to image-embed the source images (keeps the index in CLIP image space), "
                            "or provide precomputed image vectors; refusing to seed a mixed/text-space index."
                        )

                    rows.append({
                        "id": row_data.get("id", len(rows)),
                        "prompt": prompt,
                        "url": image_url,
                        "width": width,
                        "height": height,
                        "mime": "image/jpeg",
                        "embedding": embedding
                    })
            print(f"Fetched {len(rows)} rows from Hugging Face.")
        else:
            print(f"HF server returned {resp.status_code}")
    except Exception as e:
        print(f"Could not fetch from HF: {e}")

    if rows:
        count = seed_rows(rows, d1, vectorize)
        print(f"Seeded {count} rows.")
    else:
        print("No rows fetched.")


if __name__ == "__main__":
    main()
