import pytest
from sharedcache.floor import similarity_floor

def test_zero_tolerance_requires_near_exact():
    assert similarity_floor(0.0) == pytest.approx(0.98)

def test_full_tolerance_is_loosest():
    assert similarity_floor(1.0) == pytest.approx(0.70)

def test_default_is_conservative():
    assert similarity_floor(0.15) == pytest.approx(0.98 - 0.15 * 0.28)

def test_clamps_out_of_range():
    assert similarity_floor(-1.0) == pytest.approx(0.98)
    assert similarity_floor(2.0) == pytest.approx(0.70)
