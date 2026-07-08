from pydantic_settings import BaseSettings, SettingsConfigDict

from wagmiphotos.common.bge import BGE_MODEL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    gmicloud_api_key: str | None = None
    b2_key_id: str | None = None
    b2_app_key: str | None = None
    b2_bucket: str | None = None
    b2_region: str = "us-west-004"
    b2_public_url_base: str | None = None
    embedding_dims: int = 768
    default_image_model: str = "gpt-image-2-generate"
    generation_size: str = "1024x1024"   # model-dependent (Seedream needs 2048x2048)
    hf_token: str | None = None
    default_provider: str = "gmicloud"
    image_price_usd: float = 0.055   # gpt-image-2-generate @ 1024x1024 medium; quality-dependent
    generation_min_requests: int = 10   # backfill only builds prompts requested >= this many times
    # Comma-separated prompt denylist (case-insensitive, word-bounded). A blunt
    # starter guardrail against generating trademarked/branded/character content —
    # NOT exhaustive; curate for your jurisdiction. Providers disclaim infringement.
    denylist_terms: str = (
        "disney,mickey mouse,minnie mouse,pikachu,pokemon,mario,luigi,nintendo,"
        "marvel,spider-man,iron man,batman,superman,star wars,darth vader,"
        "coca-cola,pepsi,nike,adidas,gucci,prada,louis vuitton,chanel,rolex,"
        "hello kitty,harry potter,sonic the hedgehog,minecraft,fortnite")
    worker_interval_seconds: int = 300
    worker_batch_size: int = 5
    worker_max_spend_usd: float = 5.0
    worker_max_lifetime_spend_usd: float | None = None
    cf_account_id: str | None = None
    cf_api_token: str | None = None
    d1_database_id: str | None = None
    vectorize_index_prefix: str = "wagmiphotos-bge-"
    vectorize_shards: int = 3
    bge_model_name: str = BGE_MODEL
    floor_sim_max: float = 0.87
    floor_sim_min: float = 0.75
