from dataclasses import dataclass, field
from sharedcache.pricing import price_usd

@dataclass
class CostMeter:
    _ledger: list[tuple[str | None, str, float]] = field(default_factory=list)

    def cost_saved(self, provider: str, model: str) -> float:
        return price_usd(provider, model)

    def record_hit(self, api_key: str | None, asset_id: str, provider: str, model: str) -> float:
        saved = self.cost_saved(provider, model)
        self._ledger.append((api_key, asset_id, saved))
        return saved

    def total_saved(self) -> float:
        return round(sum(s for _, _, s in self._ledger), 5)
