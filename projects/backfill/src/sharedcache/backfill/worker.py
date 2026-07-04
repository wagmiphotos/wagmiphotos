import json
import logging
import sys
import uuid
from sharedcache.common.floor import similarity_floor
from sharedcache.common.models import AssetRecord
from sharedcache.generation.processor import derive_sizes, dimensions

logger = logging.getLogger(__name__)

# Cap a single rehost download so a huge (or malicious, once source_url can be
# user-influenced) upstream can't exhaust memory.
DEFAULT_MAX_REHOST_BYTES = 25 * 1024 * 1024

def normalize_prompt(s: str) -> str:
    return " ".join(s.strip().lower().split())

class BackfillWorker:
    def __init__(self, d1, vectorize, clip, generator, storage, *, floor_tolerance: float = 0.15,
                 floor_sim_max: float = 0.35, floor_sim_min: float = 0.18, batch_size: int = 5,
                 max_spend_usd: float = 5.0, price_usd: float = 0.04,
                 max_lifetime_spend_usd: float | None = None,
                 max_rehost_bytes: int = DEFAULT_MAX_REHOST_BYTES,
                 model: str = "shared-cache-gmicloud-gpt-image-1"):
        self._d1 = d1
        self._vec = vectorize
        self._clip = clip
        self._gen = generator
        self._storage = storage
        self._floor = similarity_floor(floor_tolerance, sim_max=floor_sim_max, sim_min=floor_sim_min)
        self._batch = batch_size
        self._max_spend = max_spend_usd
        self._max_lifetime_spend = max_lifetime_spend_usd
        self._lifetime_spent = 0.0
        self._max_rehost_bytes = max_rehost_bytes
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
            if (self._max_lifetime_spend is not None
                    and self._lifetime_spent + self._price > self._max_lifetime_spend):
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
            manifest = {
                "id": asset_id, "prompt": q.original_prompt, "model_used": gen.model_used,
                "content_hash": gen.content_hash, "source": "generated", "width": w, "height": h,
                "sizes": {"thumb": thumb, "medium": med, "large": url},
            }
            manifest_url = self._storage.put(
                f"assets/{asset_id}/manifest.json",
                json.dumps(manifest, sort_keys=True).encode("utf-8"), "application/json")
            rec = AssetRecord(id=asset_id, prompt=q.original_prompt, url=url, thumb_url=thumb,
                              medium_url=med, model_used=gen.model_used, source="generated",
                              source_id=None, content_hash=gen.content_hash, width=w, height=h,
                              mime="image/webp", manifest_url=manifest_url, created_at="", locally_cached=True)
            self._vec.upsert(asset_id, image_vec, {"source": "generated"})
            self._d1.insert_asset(rec)
            self._d1.mark_query_built(q.normalized_prompt, asset_id)
            spent += self._price
            self._lifetime_spent += self._price
            built += 1
        return built

    async def _download_capped(self, client, url: str) -> bytes:
        """Stream a download, aborting once it exceeds the rehost size cap."""
        buf = bytearray()
        async with client.stream("GET", url, follow_redirects=True, timeout=20.0) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"download {resp.status_code}")
            async for chunk in resp.aiter_bytes():
                buf += chunk
                if len(buf) > self._max_rehost_bytes:
                    raise RuntimeError(f"rehost source exceeds {self._max_rehost_bytes} bytes")
        return bytes(buf)

    async def rehost_pass(self) -> int:
        import httpx
        done = 0
        for rec in self._d1.assets_needing_rehost(self._batch):
            try:
                src = rec.source_url or rec.url
                async with httpx.AsyncClient() as c:
                    orig = await self._download_capped(c, src)
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

    async def run(self, interval_seconds: int, *, once: bool = False) -> None:
        import asyncio
        while True:
            try:
                result = await self.tick()
                print(f"backfill tick: {result}")
            except Exception as e:
                print(f"backfill tick failed: {e}", file=sys.stderr)
            if once:
                return
            await asyncio.sleep(interval_seconds)


def build_worker_from_settings(s) -> "BackfillWorker":
    from sharedcache.common.clip import ClipEmbedder
    from sharedcache.common.d1_client import D1Client
    from sharedcache.common.vectorize_client import VectorizeClient
    from sharedcache.generation.generator import GenblazeGenerator, StubGenerator
    from sharedcache.generation.storage import GenblazeS3Storage, InMemoryStorage
    storage = (GenblazeS3Storage(s.b2_bucket, s.b2_key_id, s.b2_app_key, s.b2_region,
                                 public_url_base=s.b2_public_url_base)
               if s.b2_bucket and s.b2_key_id else InMemoryStorage())
    if (s.gmicloud_api_key or s.openai_api_key or s.gemini_api_key) and s.b2_bucket:
        generator = GenblazeGenerator(storage, openai_api_key=s.openai_api_key,
                                      gemini_api_key=s.gemini_api_key, gmicloud_api_key=s.gmicloud_api_key)
    else:
        logger.warning("no generation API key + B2 bucket configured; falling back to "
                       "StubGenerator — no real images will be generated")
        generator = StubGenerator(storage)
    clip = ClipEmbedder(s.clip_text_embed_url, s.clip_image_embed_url, token=s.clip_embed_token)
    d1 = D1Client(s.cf_account_id, s.d1_database_id, s.cf_api_token)
    vec = VectorizeClient(s.cf_account_id, s.vectorize_index_name, s.cf_api_token)
    return BackfillWorker(d1, vec, clip, generator, storage,
                          floor_sim_max=s.floor_sim_max, floor_sim_min=s.floor_sim_min,
                          batch_size=s.worker_batch_size, max_spend_usd=s.worker_max_spend_usd,
                          max_lifetime_spend_usd=s.worker_max_lifetime_spend_usd,
                          price_usd=s.image_price_usd)
