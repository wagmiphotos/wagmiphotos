import uuid
from sharedcache.floor import similarity_floor
from sharedcache.models import AssetRecord, GenerationResult
from sharedcache.processor import make_thumbnail, dimensions, to_webp

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

    async def generate(self, prompt: str, *, cache_tolerance: float = 0.15,
                       size: str = "1024x1024", api_key: str | None = None,
                       model: str = "gpt-image-1", provider_api_key: str | None = None) -> GenerationResult:
        embedding = self._embedder.embed(prompt)
        floor = similarity_floor(cache_tolerance)

        top = self._index.search(embedding, k=1)
        if top and top[0][1] >= floor:
            record, sim = top[0]
            if not record.locally_cached:
                try:
                    import httpx
                    
                    # Save the external URL as the source_url if not already set
                    if not record.source_url:
                        record.source_url = record.url

                    async with httpx.AsyncClient() as client:
                        resp = await client.get(record.source_url, follow_redirects=True, timeout=20.0)
                        if resp.status_code != 200:
                            raise RuntimeError(f"Download failed with status {resp.status_code}")
                        orig_bytes = resp.content

                    webp_bytes = to_webp(orig_bytes)
                    thumb_bytes = make_thumbnail(orig_bytes)
                    w, h = dimensions(orig_bytes)

                    b2_url = self._storage.put(f"assets/{record.id}/image.webp", webp_bytes, "image/webp")
                    thumb_url = self._storage.put(f"assets/{record.id}/thumb.webp", thumb_bytes, "image/webp")

                    self._index.update_url(record.id, b2_url, True)
                    record.url = b2_url
                    record.thumb_url = thumb_url
                    record.locally_cached = True
                    record.width = w
                    record.height = h
                except Exception as e:
                    import sys
                    print(f"Lazy caching failed for asset {record.id}: {e}", file=sys.stderr)

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
