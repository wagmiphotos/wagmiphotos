import hashlib
import io
import json
from typing import Protocol

from PIL import Image

from sharedcache.common.models import Generated


class Generator(Protocol):
    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024", provider_api_key: str | None = None) -> Generated: ...


def _solid_png(w: int, h: int, seed: int) -> bytes:
    color = (seed % 255, (seed * 7) % 255, (seed * 13) % 255)
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


class StubGenerator:
    """Offline generator: deterministic image + manifest, persisted to Storage."""

    def __init__(self, storage) -> None:
        self._storage = storage

    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024", provider_api_key: str | None = None) -> Generated:
        w, h = (int(x) for x in size.split("x"))
        seed = int(hashlib.sha256(prompt.encode()).hexdigest(), 16) % 1000
        data = _solid_png(w, h, seed)
        content_hash = hashlib.sha256(data).hexdigest()
        key = f"assets/{content_hash}/original.png"
        url = self._storage.put(key, data, "image/png")

        inner_model = model
        if model.startswith("shared-cache-"):
            parts = model.split("-")
            if len(parts) >= 4:
                inner_model = "-".join(parts[3:])

        manifest = {
            "schema_version": "1.5",
            "prompt": prompt,
            "model": inner_model,
            "sha256": content_hash,
            "media_type": "image/png",
            "size_bytes": len(data),
        }
        manifest_json = json.dumps(manifest, sort_keys=True)
        manifest_hash = hashlib.sha256(manifest_json.encode()).hexdigest()
        return Generated(
            url=url,
            content_hash=content_hash,
            width=w,
            height=h,
            mime="image/png",
            model_used=inner_model,
            source="stub",
            manifest_json=manifest_json,
            manifest_hash=manifest_hash,
            storage_key=key,
        )


class GenblazeGenerator:
    """Real generator: Genblaze pipeline writing to B2 via the genblaze-s3 sink."""

    def __init__(self, storage, openai_api_key: str | None = None,
                 gemini_api_key: str | None = None,
                 gmicloud_api_key: str | None = None,
                 project_id: str = "sharedcache") -> None:
        self._storage = storage
        self._openai_api_key = openai_api_key
        self._gemini_api_key = gemini_api_key
        self._gmicloud_api_key = gmicloud_api_key
        self._project_id = project_id

    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024", provider_api_key: str | None = None) -> Generated:
        # Lazy imports — keeps module importable offline and in unit tests
        from genblaze_core import KeyStrategy, Modality, ObjectStorageSink, Pipeline

        # Parse provider and inner model from model ID
        # Format can be: shared-cache-<provider>-<inner-model>
        # e.g., shared-cache-openai-gpt-image-1 -> provider="openai", model="gpt-image-1"
        provider_name = "gmicloud"
        inner_model = model

        if model.startswith("shared-cache-"):
            parts = model.split("-")
            if len(parts) >= 4:
                provider_name = parts[2]
                inner_model = "-".join(parts[3:])

        # Instantiate correct provider dynamically based on provider name
        if provider_name == "openai":
            from genblaze_openai import DalleProvider
            api_key = provider_api_key or self._openai_api_key
            if not api_key:
                raise ValueError("OpenAI API Key is required for generation. Please configure it on the server.")
            provider_inst = DalleProvider(api_key=api_key)
        elif provider_name == "google":
            try:
                from genblaze_google import ImagenProvider
            except ModuleNotFoundError:
                raise ValueError("Google Imagen provider is not installed. Please install 'genblaze-google'.")
            api_key = provider_api_key or self._gemini_api_key
            if not api_key:
                raise ValueError("Google Gemini API Key is required for generation. Please configure it on the server.")
            provider_inst = ImagenProvider(api_key=api_key)
        elif provider_name == "gmicloud":
            try:
                from genblaze_gmicloud import GMICloudImageProvider
            except ModuleNotFoundError:
                raise ValueError("GMICloud provider is not installed. Please install 'genblaze-gmicloud'.")
            api_key = provider_api_key or self._gmicloud_api_key
            if not api_key:
                raise ValueError("GMICloud API Key is required for generation. Please configure it on the server.")
            provider_inst = GMICloudImageProvider(api_key=api_key)
        else:
            raise ValueError(f"Unsupported provider: {provider_name}")

        sink = ObjectStorageSink(self._storage.backend, key_strategy=KeyStrategy.CONTENT_ADDRESSABLE)

        result = await (
            Pipeline("sharedcache-gen", project_id=self._project_id, preflight=False)
            .step(
                provider_inst,
                model=inner_model,
                prompt=prompt,
                modality=Modality.IMAGE,
                size=size,
            )
            .arun(sink=sink, raise_on_failure=True, timeout=120)
        )
        asset = result.run.steps[0].assets[0]
        if not asset.sha256:
            raise ValueError(
                f"Genblaze asset has no sha256 — cannot build a cache entry (url={asset.url!r}); "
                "ensure the asset was persisted via the storage sink."
            )
        manifest_json = result.manifest.to_canonical_json()
        key = self._storage.key_from_url(asset.url)
        return Generated(
            url=asset.url,
            content_hash=asset.sha256,
            width=asset.width or 0,
            height=asset.height or 0,
            mime=asset.media_type,
            model_used=inner_model,
            source="generated",
            manifest_json=manifest_json,
            manifest_hash=result.manifest.canonical_hash,
            storage_key=key,
        )
