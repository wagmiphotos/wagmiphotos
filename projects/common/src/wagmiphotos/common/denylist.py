"""Prompt denylist — a guardrail so the backfill never generates (and the
product never redistributes) images for trademarked/branded/character prompts.

Providers give no non-infringement warranty and shift liability to the operator,
so this is our own line of defense. Matching is case-insensitive and
word-bounded (so "apple" does not trip on "pineapple"). This is a blunt
first-pass filter, not a substitute for a curated legal list."""

from __future__ import annotations

import re


class Denylist:
    def __init__(self, terms: list[str]) -> None:
        self._terms = [t.strip().lower() for t in terms if t.strip()]
        # one compiled alternation of word-bounded, escaped terms
        self._pattern = (
            re.compile(r"\b(" + "|".join(re.escape(t) for t in self._terms) + r")\b",
                       re.IGNORECASE)
            if self._terms else None)

    @classmethod
    def from_spec(cls, spec: str) -> "Denylist":
        """Build from a comma-separated spec (blank entries ignored)."""
        return cls((spec or "").split(","))

    def matched(self, prompt: str) -> str | None:
        """Return the denied term found in `prompt` (lowercased), or None."""
        if not self._pattern:
            return None
        m = self._pattern.search(prompt or "")
        return m.group(0).lower() if m else None
