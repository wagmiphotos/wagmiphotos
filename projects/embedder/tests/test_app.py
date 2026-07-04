import pytest
from fastapi.testclient import TestClient

from sharedcache.embedder.__main__ import require_token
from sharedcache.embedder.app import create_app


class FakeEncoder:
    """Deterministic encoder; raises ValueError for undecodable input like the real one."""
    def encode_text(self, text: str) -> list[float]:
        return [1.0, 2.0, 3.0]

    def encode_image(self, image_bytes: bytes) -> list[float]:
        if image_bytes == b"not-an-image":
            raise ValueError("undecodable image")
        return [4.0, 5.0, 6.0]


def client(token=None):
    return TestClient(create_app(FakeEncoder(), token=token))


def test_healthz_open_even_with_token():
    r = client(token="s3cret").get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_text_embed_returns_nested_vector():
    r = client().post("/embed/text", json={"inputs": "a fox"})
    assert r.status_code == 200
    assert r.json() == [[1.0, 2.0, 3.0]]


def test_image_embed_returns_nested_vector():
    r = client().post("/embed/image", content=b"png-bytes")
    assert r.status_code == 200
    assert r.json() == [[4.0, 5.0, 6.0]]


def test_token_required_when_configured():
    c = client(token="s3cret")
    assert c.post("/embed/text", json={"inputs": "x"}).status_code == 401
    assert c.post("/embed/text", json={"inputs": "x"},
                  headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert c.post("/embed/image", content=b"x").status_code == 401
    ok = c.post("/embed/text", json={"inputs": "x"},
                headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_no_token_means_open_access():
    assert client().post("/embed/text", json={"inputs": "x"}).status_code == 200


def test_text_input_validation():
    c = client()
    assert c.post("/embed/text", json={}).status_code == 422
    assert c.post("/embed/text", json={"inputs": 7}).status_code == 422
    assert c.post("/embed/text", json={"inputs": "   "}).status_code == 422
    assert c.post("/embed/text", content=b"not json",
                  headers={"Content-Type": "application/json"}).status_code == 422


def test_text_embed_rejects_valid_but_non_dict_json_body():
    c = client()
    assert c.post("/embed/text", json=["a", "b"]).status_code == 422
    assert c.post("/embed/text", json="just a string").status_code == 422
    assert c.post("/embed/text", json=42).status_code == 422


def test_image_input_validation():
    c = client()
    assert c.post("/embed/image", content=b"").status_code == 422
    assert c.post("/embed/image", content=b"not-an-image").status_code == 422


def test_require_token_returns_configured_value():
    assert require_token({"EMBED_TOKEN": "abc"}) == "abc"


def test_require_token_exits_when_missing_or_blank():
    import pytest
    with pytest.raises(SystemExit):
        require_token({})
    with pytest.raises(SystemExit):
        require_token({"EMBED_TOKEN": "   "})


def test_image_body_over_cap_returns_413():
    oversize = b"x" * (10 * 1024 * 1024 + 1)
    r = client().post("/embed/image", content=oversize)
    assert r.status_code == 413
