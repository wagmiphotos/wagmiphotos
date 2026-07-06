from wagmiphotos.common.bge import BGE_MODEL
from wagmiphotos.common.config import Settings

def test_defaults_apply_when_env_absent():
    s = Settings(_env_file=None)
    assert s.b2_region == "us-west-004"
    assert s.embedding_dims == 768
    assert s.default_image_model == "gpt-image-1"

def test_overrides_win():
    s = Settings(_env_file=None, b2_bucket="my-bucket", embedding_dims=3072)
    assert s.b2_bucket == "my-bucket"
    assert s.embedding_dims == 3072

def test_new_defaults(monkeypatch):
    for k in ("DEFAULT_PROVIDER", "IMAGE_PRICE_USD",
              "WORKER_INTERVAL_SECONDS", "WORKER_BATCH_SIZE", "WORKER_MAX_SPEND_USD"):
        monkeypatch.delenv(k, raising=False)
    from wagmiphotos.common.config import Settings
    s = Settings(_env_file=None)
    assert s.default_provider == "gmicloud"
    assert s.image_price_usd == 0.04
    assert s.worker_interval_seconds == 300
    assert s.worker_batch_size == 5
    assert s.worker_max_spend_usd == 5.0

def test_dead_settings_are_gone():
    for name in ("database_url", "embedder_type", "api_key",
                 "keygen_rate_per_hour", "worker_enabled"):
        assert name not in Settings.model_fields

def test_bge_model_name_default_is_the_bge_module_constant():
    assert Settings(_env_file=None).bge_model_name == BGE_MODEL

def test_cf_and_floor_defaults(monkeypatch):
    for k in ("CF_ACCOUNT_ID","CF_API_TOKEN","D1_DATABASE_ID","VECTORIZE_INDEX_NAME",
              "FLOOR_SIM_MAX","FLOOR_SIM_MIN"):
        monkeypatch.delenv(k, raising=False)
    from wagmiphotos.common.config import Settings
    s = Settings(_env_file=None)
    assert s.cf_account_id is None and s.d1_database_id is None
    assert s.vectorize_index_name is None
    assert s.floor_sim_max == 0.90 and s.floor_sim_min == 0.72
