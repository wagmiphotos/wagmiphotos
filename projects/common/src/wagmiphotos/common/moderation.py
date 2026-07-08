"""Content-safety moderation — a secondary guardrail (the denylist handles
trademark/IP; this handles unsafe content: hate, sexual, violence, self-harm).

Uses OpenAI's free Moderations endpoint. It's best-effort and injected into the
backfill; a missing key means no moderation (the denylist still runs). A GMI-LLM
classifier could implement the same `flagged(text) -> category | None` shape."""

from __future__ import annotations

MODERATIONS_URL = "https://api.openai.com/v1/moderations"


class OpenAIModerator:
    def __init__(self, api_key: str, model: str = "omni-moderation-latest",
                 *, timeout: float = 10.0) -> None:
        self._api_key = api_key
        self._model = model
        self._timeout = timeout

    async def flagged(self, text: str) -> str | None:
        """Return the first flagged safety category for `text`, or None."""
        import httpx
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                MODERATIONS_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"input": text, "model": self._model})
            resp.raise_for_status()
            result = resp.json()["results"][0]
            if not result.get("flagged"):
                return None
            for name, hit in (result.get("categories") or {}).items():
                if hit:
                    return name
            return "flagged"
