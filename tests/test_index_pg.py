import os
import uuid
import pytest
from sharedcache.index import PgCacheIndex
from sharedcache.models import AssetRecord

pytestmark = pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="no DATABASE_URL")

def _rec():
    i = str(uuid.uuid4())
    return AssetRecord(id=i, prompt="cozy cafe", url="u", thumb_url=None, provider="openai",
                       model="gpt-image-1", content_hash="h", width=1024, height=1024,
                       mime="image/webp", manifest_url=None, created_at="t")

def test_pg_insert_and_search_roundtrip():
    idx = PgCacheIndex(os.environ["DATABASE_URL"], dims=768)
    rec = _rec()
    idx.insert(rec, [0.1] * 768)
    results = idx.search([0.1] * 768, k=1)
    assert results and results[0][1] > 0.99
