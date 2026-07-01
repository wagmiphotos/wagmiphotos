from sharedcache.d1_client import QueryRow

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
