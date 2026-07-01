from dataclasses import dataclass

@dataclass
class AssetRecord:
    id: str
    prompt: str
    url: str
    thumb_url: str | None
    provider: str
    model: str
    content_hash: str
    width: int
    height: int
    mime: str
    manifest_url: str | None
    created_at: str
    source_url: str | None = None
    locally_cached: bool = True

@dataclass
class Generated:
    url: str
    content_hash: str
    width: int
    height: int
    mime: str
    provider: str
    model: str
    manifest_json: str
    manifest_hash: str
    storage_key: str

@dataclass
class GenerationResult:
    record: AssetRecord
    result: str  # "hit" | "miss"
    similarity: float
    cost_saved_usd: float
