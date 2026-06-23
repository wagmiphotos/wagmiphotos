import uuid
from sharedcache.floor import similarity_floor
from sharedcache.models import AssetRecord, GenerationResult
from sharedcache.processor import make_thumbnail, dimensions

class CacheService:
    def __init__(self, embedder, index, generator, storage, cost_meter, *, created_at_fn):
        self._embedder = embedder
        self._index = index
        self._generator = generator
        self._storage = storage
        self._cost = cost_meter
        self._now = created_at_fn

    async def generate(self, prompt: str, *, cache_tolerance: float = 0.15,
                       size: str = "1024x1024", api_key: str | None = None,
                       model: str = "gpt-image-1") -> GenerationResult:
        embedding = self._embedder.embed(prompt)
        floor = similarity_floor(cache_tolerance)

        top = self._index.search(embedding, k=1)
        if top and top[0][1] >= floor:
            record, sim = top[0]
            saved = self._cost.record_hit(api_key, record.id, record.provider, record.model)
            return GenerationResult(record=record, result="hit", similarity=sim, cost_saved_usd=saved)

        gen = await self._generator.generate(prompt, model=model, size=size)
        original = self._storage.get(gen.storage_key)
        thumb_bytes = make_thumbnail(original)
        w, h = dimensions(original)
        asset_id = str(uuid.uuid4())
        thumb_url = self._storage.put(f"assets/{asset_id}/thumb.webp", thumb_bytes, "image/webp")
        manifest_url = self._storage.put(f"assets/{asset_id}/manifest.json",
                                         gen.manifest_json.encode(), "application/json")
        record = AssetRecord(id=asset_id, prompt=prompt, url=gen.url, thumb_url=thumb_url,
                             provider=gen.provider, model=gen.model, content_hash=gen.content_hash,
                             width=w, height=h, mime=gen.mime, manifest_url=manifest_url,
                             created_at=self._now())
        self._index.insert(record, embedding)
        return GenerationResult(record=record, result="miss", similarity=0.0, cost_saved_usd=0.0)
