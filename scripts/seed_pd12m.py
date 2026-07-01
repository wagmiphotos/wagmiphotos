#!/usr/bin/env python3
"""Database seeding script for the PD12M (Public Domain 12 Million) dataset.

Downloads metadata from the Hugging Face dataset, computes CLIP embeddings
using the configured HF Inference API, and inserts the records into the index
with `locally_cached = FALSE`.

Usage:
    uv run python scripts/seed_pd12m.py --limit 100
"""
import argparse
import asyncio
import sys
import uuid
from datetime import datetime, timezone
import httpx

from sharedcache.config import Settings
from sharedcache.api import _build_from_settings
from sharedcache.models import AssetRecord

# Fallback high-quality public domain images if the Hugging Face API is rate-limited or offline
_FALLBACK_IMAGES = [
    {
        "prompt": "sunset over the ocean with dramatic red and orange clouds",
        "url": "https://upload.wikimedia.org/wikipedia/commons/a/a4/Sunset_over_the_ocean.jpg",
        "width": 1200, "height": 800, "mime": "image/jpeg"
    },
    {
        "prompt": "a vintage black bicycle parked against a brick wall with flowers in the basket",
        "url": "https://upload.wikimedia.org/wikipedia/commons/3/3b/Vintage_bicycle_against_brick_wall.jpg",
        "width": 1024, "height": 768, "mime": "image/jpeg"
    },
    {
        "prompt": "cozy library with bookshelves, leather armchair, and fireplace",
        "url": "https://upload.wikimedia.org/wikipedia/commons/2/2f/Old_library_bookshelves.jpg",
        "width": 1024, "height": 1024, "mime": "image/jpeg"
    },
    {
        "prompt": "minimalist workspace with computer, coffee cup, and green plant",
        "url": "https://upload.wikimedia.org/wikipedia/commons/e/ec/Minimalist_office_desk.jpg",
        "width": 1200, "height": 900, "mime": "image/jpeg"
    },
    {
        "prompt": "majestic snow-capped mountain peaks reflecting in a calm lake at sunrise",
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c5/Mountain_reflection_at_sunrise.jpg",
        "width": 1600, "height": 1000, "mime": "image/jpeg"
    }
]

async def seed_dataset(repo_id: str, limit: int, hf_token: str | None) -> None:
    # 1. Initialize our application services (dbs, embedder, etc.)
    app_state = _build_from_settings()
    service = app_state.state.service
    
    print(f"Starting seed process for repository: {repo_id}")
    print(f"Target count: {limit}")
    print(f"Active Embedder: {service._embedder.__class__.__name__}")
    print(f"Active Index: {service._index.__class__.__name__}")

    # 2. Attempt to fetch rows from Hugging Face Dataset Server API
    rows = []
    try:
        headers = {}
        if hf_token:
            headers["Authorization"] = f"Bearer {hf_token}"
            
        # The HF Dataset Server exposes a REST API for listing dataset rows
        url = f"https://datasets-server.huggingface.co/rows?dataset={repo_id}&config=default&split=train&offset=0&limit={limit}"
        print(f"Fetching metadata from HF Dataset Server: {url}")
        
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, headers=headers, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json()
                for item in data.get("rows", []):
                    row_data = item.get("row", {})
                    # Standard columns in PD12M
                    prompt = row_data.get("caption") or row_data.get("text")
                    image_url = row_data.get("url") or row_data.get("image_url")
                    width = int(row_data.get("width", 1024))
                    height = int(row_data.get("height", 1024))
                    
                    if prompt and image_url:
                        rows.append({
                            "prompt": prompt,
                            "url": image_url,
                            "width": width,
                            "height": height,
                            "mime": "image/jpeg" # Default fallback
                        })
                print(f"Successfully fetched {len(rows)} rows from Hugging Face.")
            else:
                print(f"Hugging Face server returned {resp.status_code}. Using fallback public domain set.")
    except Exception as e:
        print(f"Could not reach Hugging Face dataset server: {e}. Using fallback public domain set.")

    if not rows:
        rows = _FALLBACK_IMAGES[:limit]
        print(f"Using {len(rows)} local high-quality fallback items.")

    # 3. Seed into Database index
    success_count = 0
    for idx, item in enumerate(rows):
        prompt = item["prompt"]
        url = item["url"]
        print(f"[{idx+1}/{len(rows)}] Seeding: '{prompt[:40]}...'")
        
        try:
            # Generate the CLIP vector using our embedder
            embedding = service._embedder.embed(prompt)
            
            asset_id = str(uuid.uuid4())
            record = AssetRecord(
                id=asset_id,
                prompt=prompt,
                url=url,
                thumb_url=None, # Loaded on demand during lazy cache hit
                provider="public-domain",
                model="pd12m-clip",
                content_hash=f"pd12m-{idx}",
                width=item["width"],
                height=item["height"],
                mime=item["mime"],
                manifest_url=None,
                created_at=datetime.now(timezone.utc).isoformat(),
                source_url=url,
                locally_cached=False # Trigger lazy caching download on hit
            )
            
            # Insert record and vector
            service._index.insert(record, embedding)
            success_count += 1
        except Exception as e:
            print(f"Failed to seed '{prompt[:30]}': {e}")
            
    print(f"\nSeeding completed! Successfully added {success_count} assets to the cache index.")

def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the SharedCache index with PD12M images.")
    parser.add_argument("--repo-id", default="jorissup/PD12M-bucket", help="HF Dataset Repository ID")
    parser.add_argument("--limit", type=int, default=5, help="Number of items to seed")
    args = parser.parse_args()

    settings = Settings()
    hf_token = settings.hf_token
    
    asyncio.run(seed_dataset(args.repo_id, args.limit, hf_token))

if __name__ == "__main__":
    main()
