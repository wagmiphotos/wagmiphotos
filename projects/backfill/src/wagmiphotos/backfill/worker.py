import json
import logging
import uuid

from wagmiphotos.common.d1_client import QueryRow
from wagmiphotos.common.floor import DEFAULT_CACHE_TOLERANCE, similarity_floor
from wagmiphotos.common.models import AssetRecord
from wagmiphotos.generation.processor import derive_sizes, dimensions

logger = logging.getLogger(__name__)

# Cap a single rehost download so a huge (or malicious, once source_url can be
# user-influenced) upstream can't exhaust memory.
DEFAULT_MAX_REHOST_BYTES = 25 * 1024 * 1024

# meta-table key for the durable lifetime spend counter (migration 0006).
SPEND_META_KEY = "backfill_lifetime_spend_usd"

# Keep last_error readable: a stack-trace-sized blob helps nobody in a TEXT column.
_MAX_ERROR_CHARS = 500


def _error_text(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"[:_MAX_ERROR_CHARS]


class BackfillWorker:
    def __init__(self, d1, vectorize, embedder, generator, storage, *,
                 model: str,
                 floor_tolerance: float = DEFAULT_CACHE_TOLERANCE,
                 floor_sim_max: float = 0.90, floor_sim_min: float = 0.72, batch_size: int = 5,
                 max_spend_usd: float = 5.0, price_usd: float = 0.04,
                 max_lifetime_spend_usd: float | None = None,
                 max_rehost_bytes: int = DEFAULT_MAX_REHOST_BYTES):
        self._d1 = d1
        self._vec = vectorize
        self._embedder = embedder
        self._gen = generator
        self._storage = storage
        self._floor = similarity_floor(floor_tolerance, sim_max=floor_sim_max, sim_min=floor_sim_min)
        self._batch = batch_size
        self._max_spend = max_spend_usd
        self._max_lifetime_spend = max_lifetime_spend_usd
        self._lifetime_spent: float | None = None  # lazily read from meta
        self._pass_spent = 0.0
        self._max_rehost_bytes = max_rehost_bytes
        self._price = price_usd
        self._model = model

    # -- spend accounting ---------------------------------------------------

    def _lifetime_total(self) -> float:
        """Lifetime spend, read once from the durable meta counter."""
        if self._lifetime_spent is None:
            raw = self._d1.get_meta(SPEND_META_KEY)
            self._lifetime_spent = float(raw) if raw is not None else 0.0
        return self._lifetime_spent

    def _lifetime_cap_reached(self) -> bool:
        return (self._max_lifetime_spend is not None
                and self._lifetime_total() + self._price > self._max_lifetime_spend)

    def _record_spend(self, amount: float) -> None:
        before = self._lifetime_total()
        self._d1.add_meta_float(SPEND_META_KEY, amount)  # durable first
        self._lifetime_spent = before + amount
        self._pass_spent += amount

    # -- generation ----------------------------------------------------------

    async def generate_pass(self) -> int:
        built = 0
        self._pass_spent = 0.0
        for q in self._d1.pending_queries(self._batch):
            # Claim before doing any work so two workers (or one worker racing
            # Vectorize's eventual consistency) can't double-generate a prompt.
            if not self._d1.claim_query(q.normalized_prompt):
                continue
            try:
                prompt_vec = self._embedder.text_embed(q.original_prompt)
                match = self._vec.query(prompt_vec, top_k=1)
                if (match and match[0]["score"] >= self._floor
                        and self._d1.asset_exists(match[0]["id"])):
                    # An existing asset serves this prompt. The asset_exists
                    # check keeps a dangling vector from "satisfying" demand.
                    self._d1.mark_query_built(q.normalized_prompt, match[0]["id"],
                                              similarity=match[0]["score"])
                    continue
                if self._pass_spent + self._price > self._max_spend or self._lifetime_cap_reached():
                    self._d1.release_query_claim(q.normalized_prompt)
                    break
                await self._generate_one(q, prompt_vec)
                built += 1
            except Exception as e:
                # Isolate the failure: one poisoned prompt must not stall the
                # queue. The attempt counter drops it after MAX_QUERY_ATTEMPTS.
                logger.exception("backfill generation failed for %r", q.normalized_prompt)
                self._d1.record_query_failure(q.normalized_prompt, _error_text(e))
        return built

    async def _generate_one(self, q: QueryRow, prompt_vec: list[float]) -> None:
        gen = await self._gen.generate(q.original_prompt, model=self._model, size="1024x1024")
        # The provider was paid the moment generate() returned — record the
        # spend durably before any downstream step can fail.
        self._record_spend(self._price)
        original = self._storage.get(gen.storage_key)
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
        # D1 first: if the vector upsert fails we're left with a
        # servable-but-unindexed asset instead of a dangling vector.
        self._d1.insert_asset(rec)
        self._vec.upsert(asset_id, prompt_vec, {"source": "generated"})
        self._d1.mark_query_built(q.normalized_prompt, asset_id, similarity=1.0)

    # -- rehosting -------------------------------------------------------------

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
        records = self._d1.assets_needing_rehost(self._batch)
        if not records:
            return 0
        done = 0
        async with httpx.AsyncClient() as client:  # one client for the whole pass
            for rec in records:
                try:
                    src = rec.source_url or rec.url
                    orig = await self._download_capped(client, src)
                    sizes = derive_sizes(orig)
                    w, h = dimensions(sizes["large"])
                    url = self._storage.put(f"assets/{rec.id}/image.webp", sizes["large"], "image/webp")
                    med = self._storage.put(f"assets/{rec.id}/medium.webp", sizes["medium"], "image/webp")
                    thumb = self._storage.put(f"assets/{rec.id}/thumb.webp", sizes["thumb"], "image/webp")
                    self._d1.update_asset_urls(rec.id, url=url, medium_url=med, thumb_url=thumb,
                                               width=w, height=h, mime="image/webp", locally_cached=True)
                    done += 1
                except Exception:
                    logger.exception("rehost failed for asset %s", rec.id)
                    # Budgeted retries: a permanently failing source stops
                    # blocking the head of the rehost queue.
                    self._d1.increment_rehost_attempts(rec.id)
        return done

    async def tick(self) -> dict:
        return {"generated": await self.generate_pass(), "rehosted": await self.rehost_pass()}

    async def run(self, interval_seconds: int, *, once: bool = False) -> None:
        import asyncio
        while True:
            try:
                result = await self.tick()
                logger.info("backfill tick: %s", result)
            except Exception:
                logger.exception("backfill tick failed")
            if once:
                return
            await asyncio.sleep(interval_seconds)


def build_worker_from_settings(s) -> "BackfillWorker":
    from wagmiphotos.common.bge import BgeEmbedder
    from wagmiphotos.common.d1_client import D1Client
    from wagmiphotos.common.vectorize_client import VectorizeClient
    from wagmiphotos.generation import storage as storage_mod
    from wagmiphotos.generation.generator import GenblazeGenerator, StubGenerator, build_model_id

    # The B2 triple is one unit: all set -> real storage, none -> in-memory
    # stub, a partial mix -> fail now (it used to fail at generation time).
    b2 = {"B2_BUCKET": s.b2_bucket, "B2_KEY_ID": s.b2_key_id, "B2_APP_KEY": s.b2_app_key}
    missing = [name for name, value in b2.items() if not value]
    if missing and len(missing) < len(b2):
        raise ValueError(
            "partial B2 configuration: missing " + ", ".join(missing) +
            " — set all of B2_BUCKET, B2_KEY_ID, B2_APP_KEY, or none of them")
    b2_configured = not missing
    storage = (storage_mod.GenblazeS3Storage(s.b2_bucket, s.b2_key_id, s.b2_app_key, s.b2_region,
                                             public_url_base=s.b2_public_url_base)
               if b2_configured else storage_mod.InMemoryStorage())

    model = build_model_id(s.default_provider, s.default_image_model)
    if (s.gmicloud_api_key or s.openai_api_key or s.gemini_api_key) and b2_configured:
        generator = GenblazeGenerator(storage, openai_api_key=s.openai_api_key,
                                      gemini_api_key=s.gemini_api_key, gmicloud_api_key=s.gmicloud_api_key)
        generator.preflight(model)  # missing provider/key fails at startup
    else:
        logger.warning("no generation API key + B2 bucket configured; falling back to "
                       "StubGenerator — no real images will be generated")
        generator = StubGenerator(storage)
    embedder = BgeEmbedder.from_pretrained(s.bge_model_name)
    d1 = D1Client(s.cf_account_id, s.d1_database_id, s.cf_api_token)
    vec = VectorizeClient(s.cf_account_id, s.vectorize_index_prefix, s.vectorize_shards, s.cf_api_token,
                          dims=s.embedding_dims)
    return BackfillWorker(d1, vec, embedder, generator, storage, model=model,
                          floor_sim_max=s.floor_sim_max, floor_sim_min=s.floor_sim_min,
                          batch_size=s.worker_batch_size, max_spend_usd=s.worker_max_spend_usd,
                          max_lifetime_spend_usd=s.worker_max_lifetime_spend_usd,
                          price_usd=s.image_price_usd)
