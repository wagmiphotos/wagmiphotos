from dataclasses import dataclass

@dataclass
class AssetRecord:
    id: str
    prompt: str
    model_used: str | None
    source: str              # "pd12m" | "generated" | "stub"
    source_id: str | None
    content_hash: str
    width: int
    height: int
    mime: str
    created_at: str
    source_url: str | None = None
    locally_cached: bool = True
    price_usd: float | None = None   # cost charged at generation; None for seed/rehost
    provider: str | None = None      # generation backend; None for seed/rehost

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
    provider: str | None = None
