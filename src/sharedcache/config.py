from pydantic_settings import BaseSettings, SettingsConfigDict


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
    database_url: str | None = None
    embedding_dims: int = 768
    default_image_model: str = "gpt-image-1"
    api_key: str | None = None
    hf_token: str | None = None
    embedder_type: str = "gemini"
    default_provider: str = "gmicloud"
    image_price_usd: float = 0.04
    worker_enabled: bool = True
    worker_interval_seconds: int = 300
    worker_batch_size: int = 5
    worker_max_spend_usd: float = 5.0
    keygen_rate_per_hour: int = 10
    cf_account_id: str | None = None
    cf_api_token: str | None = None
    d1_database_id: str | None = None
    vectorize_index_name: str | None = None
    clip_text_embed_url: str | None = None
    clip_image_embed_url: str | None = None
    clip_embed_token: str | None = None
    floor_sim_max: float = 0.35
    floor_sim_min: float = 0.18
