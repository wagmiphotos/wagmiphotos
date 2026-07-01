from sharedcache.common.d1_client import QueryRow

class FakeD1:
    def __init__(self):
        self.pending: list[QueryRow] = []
        self.assets: dict[str, dict] = {}     # id -> asset fields
        self.rehost: list = []                # AssetRecord needing rehost
        self.built: list[tuple[str, str]] = []
        self.inserted: list = []
        self.url_updates: list[tuple] = []
    def pending_queries(self, limit):
        return self.pending[:limit]
    def mark_query_built(self, normalized_prompt, asset_id):
        self.built.append((normalized_prompt, asset_id))
        self.pending = [q for q in self.pending if q.normalized_prompt != normalized_prompt]
    def insert_asset(self, rec):
        self.inserted.append(rec); self.assets[rec.id] = rec
    def assets_needing_rehost(self, limit):
        return self.rehost[:limit]
    def update_asset_urls(self, asset_id, **kw):
        self.url_updates.append((asset_id, kw))
        self.rehost = [a for a in self.rehost if a.id != asset_id]

class FakeVectorize:
    def __init__(self):
        self.vectors: dict[str, dict] = {}   # id -> {"values","metadata"}
        self._forced: dict[str, float] = {}   # id -> score for next query
    def set_score(self, id: str, score: float):
        self._forced[id] = score
    def query(self, values, top_k=1):
        if self._forced:
            best = max(self._forced.items(), key=lambda kv: kv[1])
            return [{"id": best[0], "score": best[1], "metadata": self.vectors.get(best[0], {}).get("metadata", {})}]
        return []
    def upsert(self, id, values, metadata):
        self.vectors[id] = {"values": values, "metadata": metadata}
    def insert_many(self, vectors):
        for v in vectors:
            self.vectors[v["id"]] = {"values": v["values"], "metadata": v.get("metadata", {})}
