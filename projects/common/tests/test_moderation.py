import pytest

from wagmiphotos.common.moderation import OpenAIModerator


class _FakeResp:
    def __init__(self, payload):
        self._p = payload
    def raise_for_status(self):
        pass
    def json(self):
        return self._p


class _FakeClient:
    def __init__(self, payload):
        self._p = payload
        self.posted = None
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    async def post(self, url, **kw):
        self.posted = (url, kw)
        return _FakeResp(self._p)


def _patch(monkeypatch, payload):
    import httpx
    client = _FakeClient(payload)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: client)
    return client


@pytest.mark.asyncio
async def test_flagged_returns_the_first_hit_category(monkeypatch):
    _patch(monkeypatch, {"results": [{"flagged": True,
                                      "categories": {"hate": False, "violence": True}}]})
    assert await OpenAIModerator("sk-test").flagged("something bad") == "violence"


@pytest.mark.asyncio
async def test_not_flagged_returns_none(monkeypatch):
    _patch(monkeypatch, {"results": [{"flagged": False, "categories": {"violence": False}}]})
    assert await OpenAIModerator("sk-test").flagged("a cat") is None


@pytest.mark.asyncio
async def test_posts_prompt_model_and_bearer(monkeypatch):
    client = _patch(monkeypatch, {"results": [{"flagged": False, "categories": {}}]})
    await OpenAIModerator("sk-test", model="omni-moderation-latest").flagged("hello")
    url, kw = client.posted
    assert "/moderations" in url
    assert kw["json"]["input"] == "hello" and kw["json"]["model"] == "omni-moderation-latest"
    assert kw["headers"]["Authorization"] == "Bearer sk-test"
