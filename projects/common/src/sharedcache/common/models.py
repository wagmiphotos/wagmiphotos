from dataclasses import dataclass

@dataclass
class AssetRecord:
    id: str
    prompt: str
    url: str                 # large webp
    thumb_url: str | None
    medium_url: str | None
    model_used: str | None
    source: str              # "pd12m" | "generated" | "stub"
    source_id: str | None
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
    model_used: str
    source: str
    manifest_json: str
    manifest_hash: str
    storage_key: str

@dataclass
class GenerationResult:
    record: AssetRecord
    result: str  # "hit" | "miss"
    similarity: float
    cost_saved_usd: float
