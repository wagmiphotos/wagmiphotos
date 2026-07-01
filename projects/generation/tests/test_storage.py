import sys
from sharedcache.generation.storage import InMemoryStorage, GenblazeS3Storage, Storage

def test_put_returns_url_and_get_roundtrips():
    s = InMemoryStorage()
    url = s.put("assets/x/thumb.webp", b"bytes", "image/webp")
    assert "assets/x/thumb.webp" in url
    assert s.get(s.key_from_url(url)) == b"bytes"

def test_inmemory_satisfies_storage_protocol():
    assert isinstance(InMemoryStorage(), Storage)

def test_genblaze_storage_has_protocol_methods():
    for m in ("put", "get", "key_from_url"):
        assert callable(getattr(GenblazeS3Storage, m, None))

def test_genblaze_s3_import_is_lazy():
    import sharedcache.generation.storage  # noqa: F401
    assert "genblaze_s3" not in sys.modules
