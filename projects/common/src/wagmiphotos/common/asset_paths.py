"""B2 object keys per asset. Parity with contract.json asset_paths (and the
worker's URL derivation) is pinned by test_contract; the backfill MUST write
to exactly these keys or derived URLs 404."""
ASSET_PATHS = {
    "large": "assets/{id}/image.webp",
    "medium": "assets/{id}/medium.webp",
    "thumb": "assets/{id}/thumb.webp",
    "manifest": "assets/{id}/manifest.json",
}


def asset_key(size: str, asset_id: str) -> str:
    return ASSET_PATHS[size].format(id=asset_id)
