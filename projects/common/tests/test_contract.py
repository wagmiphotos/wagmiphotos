"""Pin the Python constants to contract.json (shared with the TS edge worker).

A mismatch here means the two sides have drifted: fix contract.json first,
then both implementations."""
import inspect
import json
import pathlib

from wagmiphotos.common import bge, floor
from wagmiphotos.common.config import Settings

CONTRACT = json.loads(
    (pathlib.Path(__file__).resolve().parents[3] / "contract.json").read_text())


def test_floor_defaults_match_contract():
    sig = inspect.signature(floor.similarity_floor)
    assert sig.parameters["sim_max"].default == CONTRACT["floor_sim_max"]
    assert sig.parameters["sim_min"].default == CONTRACT["floor_sim_min"]


def test_default_cache_tolerance_matches_contract():
    assert floor.DEFAULT_CACHE_TOLERANCE == CONTRACT["default_cache_tolerance"]


def test_config_defaults_match_contract():
    s = Settings(_env_file=None)
    assert s.floor_sim_max == CONTRACT["floor_sim_max"]
    assert s.floor_sim_min == CONTRACT["floor_sim_min"]
    assert s.embedding_dims == CONTRACT["embedding_dims"]
    assert s.bge_model_name == CONTRACT["bge_model_sentence_transformers"]


def test_vectorize_config_matches_contract():
    # Explicit _env_file=None isolation per test_config.py convention: these
    # fields must reflect the shipped defaults, not a developer's local .env.
    s = Settings(_env_file=None)
    assert s.vectorize_index_prefix == CONTRACT["vectorize_index_prefix"]
    assert s.vectorize_shards == CONTRACT["vectorize_shards"]


def test_bge_model_matches_contract():
    assert bge.BGE_MODEL == CONTRACT["bge_model_sentence_transformers"]


from wagmiphotos.common.shard import fnv1a32, shard_for


def test_shard_routing_matches_contract_fixtures():
    for asset_id, shard in CONTRACT["shard_fixtures"].items():
        assert shard_for(asset_id, CONTRACT["vectorize_shards"]) == shard


def test_fnv1a32_reference_value():
    assert fnv1a32("demo-1") == 207613968


from wagmiphotos.common.asset_paths import ASSET_PATHS, asset_key


def test_asset_paths_match_contract():
    assert ASSET_PATHS == CONTRACT["asset_paths"]


def test_asset_key_substitutes_id():
    assert asset_key("thumb", "abc") == "assets/abc/thumb.webp"


def test_denylist_terms_match_contract():
    from wagmiphotos.common.config import Settings
    config_terms = [t.strip() for t in Settings().denylist_terms.split(",") if t.strip()]
    assert config_terms == CONTRACT["denylist_terms"]


def test_byok_gmicloud_price_matches_image_price():
    from wagmiphotos.common.config import Settings
    assert CONTRACT["byok_providers"]["gmicloud"]["price_per_image_usd"] == Settings().image_price_usd
    assert CONTRACT["byok_providers"]["gmicloud"]["model"] == "gpt-image-2-generate"
