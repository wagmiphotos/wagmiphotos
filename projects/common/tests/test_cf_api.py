import httpx
import pytest

from wagmiphotos.common import cf_api


class _Resp:
    def __init__(self, data=None, status=200):
        self._d = data if data is not None else {"success": True, "result": {}}
        self.status_code = status
        self.text = "err-body"

    def json(self):
        return self._d


class _Client:
    """Scripted httpx-like client: pops one outcome per post call."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def post(self, url, **kw):
        self.calls += 1
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    sleeps = []
    monkeypatch.setattr(cf_api.time, "sleep", lambda s: sleeps.append(s))
    return sleeps


def test_post_retries_on_429_then_succeeds(no_sleep):
    c = _Client([_Resp(status=429), _Resp({"success": True, "result": {"ok": 1}})])
    body = cf_api.post_with_retry(c, "https://x", what="D1 query", json={})
    assert body["result"] == {"ok": 1}
    assert c.calls == 2
    assert no_sleep == [0.5]


def test_post_retries_on_5xx_and_transport_error(no_sleep):
    c = _Client([_Resp(status=503), httpx.ConnectError("boom"), _Resp()])
    body = cf_api.post_with_retry(c, "https://x", what="Vectorize upsert")
    assert body["success"] is True
    assert c.calls == 3
    assert no_sleep == [0.5, 2.0]


def test_post_gives_up_after_three_attempts(no_sleep):
    c = _Client([_Resp(status=500)] * 5)
    with pytest.raises(RuntimeError) as e:
        cf_api.post_with_retry(c, "https://x", what="D1 query")
    assert c.calls == 3
    assert "D1 query" in str(e.value)


def test_post_does_not_retry_client_errors(no_sleep):
    c = _Client([_Resp(status=400)] * 3)
    with pytest.raises(RuntimeError):
        cf_api.post_with_retry(c, "https://x", what="D1 query")
    assert c.calls == 1


def test_post_raises_on_success_false(no_sleep):
    c = _Client([_Resp({"success": False, "errors": ["nope"]})])
    with pytest.raises(RuntimeError) as e:
        cf_api.post_with_retry(c, "https://x", what="D1 query")
    assert "nope" in str(e.value)


def test_transport_error_exhaustion_raises_runtime_error(no_sleep):
    c = _Client([httpx.ConnectError("down")] * 3)
    with pytest.raises(RuntimeError) as e:
        cf_api.post_with_retry(c, "https://x", what="D1 query")
    assert "down" in str(e.value) and c.calls == 3


def test_api_base_constant():
    assert cf_api.API_BASE == "https://api.cloudflare.com/client/v4"
