import sys
import uuid
from sharedcache.floor import similarity_floor
from sharedcache.models import AssetRecord
from sharedcache.processor import derive_sizes, dimensions

def normalize_prompt(s: str) -> str:
    return " ".join(s.strip().lower().split())

class BackfillWorker:
    def __init__(self, d1, vectorize, clip, generator, storage, *, floor_tolerance: float = 0.15,
                 floor_sim_max: float = 0.35, floor_sim_min: float = 0.18, batch_size: int = 5,
                 max_spend_usd: float = 5.0, price_usd: float = 0.04,
                 model: str = "shared-cache-gmicloud-gpt-image-1"):
        self._d1 = d1
        self._vec = vectorize
        self._clip = clip
        self._gen = generator
        self._storage = storage
        self._floor = similarity_floor(floor_tolerance, sim_max=floor_sim_max, sim_min=floor_sim_min)
        self._batch = batch_size
        self._max_spend = max_spend_usd
        self._price = price_usd
        self._model = model

    async def generate_pass(self) -> int:
        built = 0
        spent = 0.0
        for q in self._d1.pending_queries(self._batch):
            match = self._vec.query(self._clip.text_embed(q.original_prompt), top_k=1)
            if match and match[0]["score"] >= self._floor:
                self._d1.mark_query_built(q.normalized_prompt, match[0]["id"])
                continue
            if spent + self._price > self._max_spend:
                break
            gen = await self._gen.generate(q.original_prompt, model=self._model, size="1024x1024")
            original = self._storage.get(gen.storage_key)
            image_vec = self._clip.image_embed(original)
            sizes = derive_sizes(original)
            w, h = dimensions(sizes["large"])
            asset_id = str(uuid.uuid4())
            url = self._storage.put(f"assets/{asset_id}/image.webp", sizes["large"], "image/webp")
            med = self._storage.put(f"assets/{asset_id}/medium.webp", sizes["medium"], "image/webp")
            thumb = self._storage.put(f"assets/{asset_id}/thumb.webp", sizes["thumb"], "image/webp")
            rec = AssetRecord(id=asset_id, prompt=q.original_prompt, url=url, thumb_url=thumb,
                              medium_url=med, model_used=gen.model_used, source="generated",
                              source_id=None, content_hash=gen.content_hash, width=w, height=h,
                              mime="image/webp", manifest_url=None, created_at="", locally_cached=True)
            self._vec.upsert(asset_id, image_vec, {"source": "generated"})
            self._d1.insert_asset(rec)
            self._d1.mark_query_built(q.normalized_prompt, asset_id)
            spent += self._price
            built += 1
        return built

    async def rehost_pass(self) -> int:
        import httpx
        done = 0
        for rec in self._d1.assets_needing_rehost(self._batch):
            try:
                src = rec.source_url or rec.url
                async with httpx.AsyncClient() as c:
                    resp = await c.get(src, follow_redirects=True, timeout=20.0)
                    if resp.status_code != 200:
                        raise RuntimeError(f"download {resp.status_code}")
                    orig = resp.content
                sizes = derive_sizes(orig)
                w, h = dimensions(sizes["large"])
                url = self._storage.put(f"assets/{rec.id}/image.webp", sizes["large"], "image/webp")
                med = self._storage.put(f"assets/{rec.id}/medium.webp", sizes["medium"], "image/webp")
                thumb = self._storage.put(f"assets/{rec.id}/thumb.webp", sizes["thumb"], "image/webp")
                self._d1.update_asset_urls(rec.id, url=url, medium_url=med, thumb_url=thumb,
                                           width=w, height=h, mime="image/webp", locally_cached=True)
                done += 1
            except Exception as e:
                print(f"rehost failed for {rec.id}: {e}", file=sys.stderr)
        return done

    async def tick(self) -> dict:
        return {"generated": await self.generate_pass(), "rehosted": await self.rehost_pass()}
