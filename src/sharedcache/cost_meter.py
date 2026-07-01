from dataclasses import dataclass, field

@dataclass
class CostMeter:
    price_usd: float = 0.04
    _ledger: list[tuple[str | None, str, float]] = field(default_factory=list)

    def record_hit(self, api_key: str | None, asset_id: str) -> float:
        self._ledger.append((api_key, asset_id, self.price_usd))
        return self.price_usd

    def total_saved(self) -> float:
        return round(sum(s for _, _, s in self._ledger), 5)
