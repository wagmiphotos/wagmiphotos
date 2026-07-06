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


def test_bge_model_matches_contract():
    assert bge.BGE_MODEL == CONTRACT["bge_model_sentence_transformers"]
