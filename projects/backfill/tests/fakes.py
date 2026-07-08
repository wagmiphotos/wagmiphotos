from wagmiphotos.common.d1_client import QueryRow

class FakeD1:
    """In-memory stand-in mirroring D1Client semantics (claims, attempts,
    rehost budget, meta counter). Claim state: absent = unclaimed,
    "fresh" = held, "stale" = expired and reclaimable."""

    def __init__(self):
        self.pending: list[QueryRow] = []
        self.assets: dict[str, object] = {}   # id -> asset record
        self.rehost: list = []                # AssetRecord needing rehost
        self.built: list[tuple[str, str]] = []
        self.similarities: dict[str, float | None] = {}
        self.inserted: list = []
        self.denied: list[tuple] = []
        self.rehost_marks: list[tuple] = []
        self.failures: list[tuple[str, str]] = []
        self.attempts: dict[str, int] = {}
        self.claims: dict[str, str] = {}
        self.rehost_attempts: dict[str, int] = {}
        self.meta: dict[str, str] = {}
        self.dead: dict[str, str] = {}

    # -- queries ----------------------------------------------------------
    def pending_queries(self, limit, min_count=1):
        # Claim filtering is deliberately NOT applied here: the SQL does it,
        # but the select->claim race is exactly what claim_query() guards, so
        # tests can hand a claimed row to the worker. The demand threshold IS
        # applied (the SQL filters count >= min_count).
        out = [q for q in self.pending
               if self.attempts.get(q.normalized_prompt, 0) < 5 and q.count >= min_count]
        return out[:limit]

    def claim_query(self, normalized_prompt):
        if self.claims.get(normalized_prompt) == "fresh":
            return False
        self.claims[normalized_prompt] = "fresh"
        return True

    def release_query_claim(self, normalized_prompt):
        self.claims.pop(normalized_prompt, None)

    def mark_query_built(self, normalized_prompt, asset_id, similarity=None):
        self.built.append((normalized_prompt, asset_id))
        self.similarities[normalized_prompt] = similarity
        self.claims.pop(normalized_prompt, None)
        self.pending = [q for q in self.pending if q.normalized_prompt != normalized_prompt]

    def deny_query(self, normalized_prompt, reason):
        self.denied.append((normalized_prompt, reason))

    def record_query_failure(self, normalized_prompt, error):
        self.failures.append((normalized_prompt, error))
        self.attempts[normalized_prompt] = self.attempts.get(normalized_prompt, 0) + 1
        self.claims.pop(normalized_prompt, None)

    # -- assets -----------------------------------------------------------
    def insert_asset(self, rec):
        self.inserted.append(rec); self.assets[rec.id] = rec

    def asset_exists(self, asset_id):
        return asset_id in self.assets and asset_id not in self.dead

    def assets_needing_rehost(self, limit):
        out = [a for a in self.rehost
               if self.rehost_attempts.get(a.id, 0) < 5 and a.id not in self.dead]
        return out[:limit]

    def increment_rehost_attempts(self, asset_id):
        self.rehost_attempts[asset_id] = self.rehost_attempts.get(asset_id, 0) + 1
        return self.rehost_attempts[asset_id]

    def mark_asset_dead(self, asset_id, reason):
        self.dead.setdefault(asset_id, reason)      # idempotent, first reason wins
        self.rehost = [a for a in self.rehost if a.id != asset_id]

    def mark_asset_rehosted(self, asset_id, *, width, height, mime):
        self.rehost_marks.append((asset_id, {"width": width, "height": height, "mime": mime}))
        self.rehost = [a for a in self.rehost if a.id != asset_id]

    # -- meta ---------------------------------------------------------------
    def get_meta(self, key):
        return self.meta.get(key)

    def add_meta_float(self, key, amount):
        self.meta[key] = str(float(self.meta.get(key, "0")) + float(amount))

    # -- seed dedupe --------------------------------------------------------
    def existing_source_ids(self, source, source_ids):
        have = {getattr(rec, "source_id", None) for rec in self.inserted
                if getattr(rec, "source", None) == source}
        return {sid for sid in source_ids if sid in have}

class FakeVectorize:
    def __init__(self):
        self.vectors: dict[str, dict] = {}   # id -> {"values","metadata"}
        self._forced: dict[str, float] = {}   # id -> score for next query
        self.insert_calls = 0
        self.deleted: list[list[str]] = []
    def set_score(self, id: str, score: float):
        self._forced[id] = score
    def query(self, values, top_k=1):
        if self._forced:
            best = max(self._forced.items(), key=lambda kv: kv[1])
            return [{"id": best[0], "score": best[1]}]
        return []
    def upsert(self, id, values, metadata):
        self.vectors[id] = {"values": values, "metadata": metadata}
    def insert_many(self, vectors):
        self.insert_calls += 1
        for v in vectors:
            self.vectors[v["id"]] = {"values": v["values"], "metadata": v.get("metadata", {})}
    def delete(self, ids):
        self.deleted.append(list(ids))
        for id in ids:
            self.vectors.pop(id, None)
