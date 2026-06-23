from sharedcache.storage import InMemoryStorage

def test_put_returns_url_and_get_roundtrips():
    s = InMemoryStorage()
    url = s.put("assets/x/thumb.webp", b"bytes", "image/webp")
    assert "assets/x/thumb.webp" in url
    assert s.get(s.key_from_url(url)) == b"bytes"
