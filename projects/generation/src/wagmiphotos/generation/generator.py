import hashlib
import importlib
import io
import json
from typing import Protocol

from PIL import Image

from wagmiphotos.common.models import Generated

MODEL_ID_PREFIX = "wagmiphotos"

# provider name -> (module, provider class, missing-key error message)
_PROVIDERS: dict[str, tuple[str, str, str]] = {
    "openai": ("genblaze_openai", "DalleProvider",
               "OpenAI API Key is required for generation. Please configure it on the server."),
    "google": ("genblaze_google", "ImagenProvider",
               "Google Gemini API Key is required for generation. Please configure it on the server."),
    "gmicloud": ("genblaze_gmicloud", "GMICloudImageProvider",
                 "GMICloud API Key is required for generation. Please configure it on the server."),
}


def build_model_id(provider: str, inner_model: str) -> str:
    """Compose the public 'wagmiphotos-<provider>-<model>' model id."""
    return f"{MODEL_ID_PREFIX}-{provider}-{inner_model}"


def parse_model_id(model: str, *, default_provider: str = "gmicloud") -> tuple[str, str]:
    """Split 'wagmiphotos-<provider>-<model>' into (provider, inner_model).

    Strings without the prefix (or too short to carry one) pass through
    unchanged with `default_provider`."""
    if model.startswith(f"{MODEL_ID_PREFIX}-"):
        prefix_parts = MODEL_ID_PREFIX.count("-") + 1
        parts = model.split("-")
        if len(parts) >= prefix_parts + 2:
            return parts[prefix_parts], "-".join(parts[prefix_parts + 1:])
    return default_provider, model


def resolve_provider(provider_name: str, api_key: str | None, *, model: str = ""):
    """Import and instantiate the genblaze provider for `provider_name`.

    Raises ValueError with an install hint when the provider package is
    missing, so misconfiguration surfaces at startup (preflight) rather than
    on the first generation."""
    spec = _PROVIDERS.get(provider_name)
    if spec is None:
        raise ValueError(f"Unsupported provider: {provider_name}")
    module_name, class_name, key_error = spec
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as e:
        package = module_name.replace("_", "-")
        raise ValueError(
            f"provider {provider_name!r} for model {model!r} is not installed — "
            f"pip install 'genblaze[{provider_name}]' (or {package})") from e
    if not api_key:
        raise ValueError(key_error)
    return getattr(module, class_name)(api_key=api_key)


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

        provider_name, inner_model = parse_model_id(model)

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
            provider=provider_name,
        )


class GenblazeGenerator:
    """Real generator: Genblaze pipeline writing to B2 via the genblaze-s3 sink."""

    def __init__(self, storage, openai_api_key: str | None = None,
                 gemini_api_key: str | None = None,
                 gmicloud_api_key: str | None = None,
                 project_id: str = "wagmiphotos") -> None:
        self._storage = storage
        self._api_keys = {
            "openai": openai_api_key,
            "google": gemini_api_key,
            "gmicloud": gmicloud_api_key,
        }
        self._project_id = project_id

    def preflight(self, model: str) -> None:
        """Resolve the provider for `model` now, so a missing provider package
        or API key fails at startup instead of on the first generation."""
        provider_name, _ = parse_model_id(model)
        resolve_provider(provider_name, self._api_keys.get(provider_name), model=model)

    async def generate(self, prompt: str, *, model: str, size: str = "1024x1024", provider_api_key: str | None = None) -> Generated:
        # Lazy imports — keeps module importable offline and in unit tests
        from genblaze_core import KeyStrategy, Modality, ObjectStorageSink, Pipeline

        provider_name, inner_model = parse_model_id(model)
        api_key = provider_api_key or self._api_keys.get(provider_name)
        provider_inst = resolve_provider(provider_name, api_key, model=model)

        sink = ObjectStorageSink(self._storage.backend, key_strategy=KeyStrategy.CONTENT_ADDRESSABLE)

        result = await (
            Pipeline("wagmiphotos-gen", project_id=self._project_id, preflight=False)
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
            provider=provider_name,
        )
