# pricing.py — public per-image prices (USD). Genblaze ships none, so we keep our own.
_PRICES: dict[tuple[str, str], float] = {
    ("openai", "gpt-image-1"): 0.04,
    ("openai", "dall-e-3"): 0.04,
    ("google", "imagen-3.0-generate-002"): 0.04,
    ("stub", "gpt-image-1"): 0.04,
}

def price_usd(provider: str, model: str) -> float:
    return _PRICES.get((provider, model), 0.0)
