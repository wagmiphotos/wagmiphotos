import time
from collections import defaultdict, deque

class SlidingWindowLimiter:
    """In-memory per-key sliding-window rate limiter. Single-process only."""
    def __init__(self, max_events: int, window_seconds: float, now_fn=time.monotonic) -> None:
        self._max = max_events
        self._window = window_seconds
        self._now = now_fn
        self._events: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self._now()
        q = self._events[key]
        while q and now - q[0] >= self._window:
            q.popleft()
        if len(q) >= self._max:
            return False
        q.append(now)
        return True
