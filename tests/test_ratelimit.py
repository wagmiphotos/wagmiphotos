from sharedcache.ratelimit import SlidingWindowLimiter

def test_limiter_allows_then_blocks():
    clock = {"t": 0.0}
    lim = SlidingWindowLimiter(max_events=2, window_seconds=100.0, now_fn=lambda: clock["t"])
    assert lim.allow("ip") is True
    assert lim.allow("ip") is True
    assert lim.allow("ip") is False          # third within window blocked
    clock["t"] = 101.0
    assert lim.allow("ip") is True            # window slid; allowed again

def test_limiter_is_per_key():
    lim = SlidingWindowLimiter(max_events=1, window_seconds=100.0, now_fn=lambda: 0.0)
    assert lim.allow("a") is True
    assert lim.allow("b") is True             # different key, own budget
    assert lim.allow("a") is False
