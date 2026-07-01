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

    @property
    def storage(self):
        return self._storage

    async def ensure_local(self, record) -> None:
        if record.locally_cached:
            return
        try:
            import httpx
            src = record.source_url or record.url
            record.source_url = src
            async with httpx.AsyncClient() as client:
                resp = await client.get(src, follow_redirects=True, timeout=20.0)
                if resp.status_code != 200:
                    raise RuntimeError(f"Download failed with status {resp.status_code}")
                orig = resp.content
            from sharedcache.processor import derive_sizes, dimensions
            sizes = derive_sizes(orig)
            w, h = dimensions(sizes["large"])
            large_url = self._storage.put(f"assets/{record.id}/image.webp", sizes["large"], "image/webp")
            med_url = self._storage.put(f"assets/{record.id}/medium.webp", sizes["medium"], "image/webp")
            thumb_url = self._storage.put(f"assets/{record.id}/thumb.webp", sizes["thumb"], "image/webp")
            self._index.update_urls(record.id, url=large_url, medium_url=med_url, thumb_url=thumb_url,
                                    width=w, height=h, mime="image/webp", locally_cached=True)
            record.url, record.medium_url, record.thumb_url = large_url, med_url, thumb_url
            record.width, record.height, record.mime, record.locally_cached = w, h, "image/webp", True
        except Exception as e:
            import sys
            print(f"Lazy caching failed for asset {record.id}: {e}", file=sys.stderr)

    async def generate(self, prompt: str, *, cache_tolerance: float = 0.15,
                       size: str = "1024x1024", api_key: str | None = None,
                       model: str = "gpt-image-1", provider_api_key: str | None = None) -> GenerationResult:
        embedding = self._embedder.embed(prompt)
        floor = similarity_floor(cache_tolerance)

        top = self._index.search(embedding, k=1)
        if top and top[0][1] >= floor:
            record, sim = top[0]
            await self.ensure_local(record)

            saved = self._cost.record_hit(api_key, record.id)
            return GenerationResult(record=record, result="hit", similarity=sim, cost_saved_usd=saved)

        gen = await self._generator.generate(prompt, model=model, size=size, provider_api_key=provider_api_key)
        original = self._storage.get(gen.storage_key)
        thumb_bytes = make_thumbnail(original)
        w, h = dimensions(original)
        asset_id = str(uuid.uuid4())
        thumb_url = self._storage.put(f"assets/{asset_id}/thumb.webp", thumb_bytes, "image/webp")
        manifest_url = self._storage.put(f"assets/{asset_id}/manifest.json",
                                         gen.manifest_json.encode(), "application/json")
        record = AssetRecord(id=asset_id, prompt=prompt, url=gen.url, thumb_url=thumb_url,
                             medium_url=None, model_used=gen.model_used, source=gen.source,
                             source_id=None, content_hash=gen.content_hash,
                             width=w, height=h, mime=gen.mime, manifest_url=manifest_url,
                             created_at=self._now())
        self._index.insert(record, embedding)
        return GenerationResult(record=record, result="miss", similarity=0.0, cost_saved_usd=0.0)
