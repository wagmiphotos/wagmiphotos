from typing import Protocol, runtime_checkable


@runtime_checkable
class Storage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> str: ...
    def get(self, key: str) -> bytes: ...
    def key_from_url(self, url: str) -> str: ...


class InMemoryStorage:
    BASE = "memory://sharedcache/"

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self._blobs[key] = data
        return self.BASE + key

    def get(self, key: str) -> bytes:
        return self._blobs[key]

    def key_from_url(self, url: str) -> str:
        return url.split(self.BASE, 1)[-1] if url.startswith(self.BASE) else url


class GenblazeS3Storage:
    """Wraps Genblaze's S3 backend so the same B2 backend is used for the
    generation sink (Task 8) and for our thumbnail put/get."""

    def __init__(self, bucket: str, key_id: str, app_key: str, region: str = "us-west-004"):
        from genblaze_s3 import S3StorageBackend  # lazy import — keeps module importable offline

        self.backend = S3StorageBackend.for_backblaze(
            bucket, region=region, key_id=key_id, app_key=app_key
        )

    def put(self, key: str, data: bytes, content_type: str) -> str:
        # backend.put() returns the storage key (changed in 0.3.0 — used to return a URL)
        self.backend.put(key, data, content_type=content_type)
        return self.backend.get_url(key)

    def get(self, key: str) -> bytes:
        return self.backend.get(key)

    def key_from_url(self, url: str) -> str:
        # backend.key_from_url returns str | None; fall back to url on None
        result = self.backend.key_from_url(url)
        return result if result is not None else url
