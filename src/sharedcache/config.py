from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    b2_key_id: str | None = None
    b2_app_key: str | None = None
    b2_bucket: str | None = None
    b2_region: str = "us-west-004"
    b2_public_url_base: str | None = None
    database_url: str | None = None
    embedding_dims: int = 768
    default_image_model: str = "gpt-image-1"
    api_key: str | None = None
