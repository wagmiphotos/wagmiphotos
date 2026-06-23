from sharedcache.config import Settings

def test_defaults_apply_when_env_absent():
    s = Settings(_env_file=None)
    assert s.b2_region == "us-west-004"
    assert s.embedding_dims == 768
    assert s.default_image_model == "gpt-image-1"

def test_overrides_win():
    s = Settings(_env_file=None, b2_bucket="my-bucket", embedding_dims=3072)
    assert s.b2_bucket == "my-bucket"
    assert s.embedding_dims == 3072
