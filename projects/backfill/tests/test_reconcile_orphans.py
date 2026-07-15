from wagmiphotos.common.shard import shard_for
from wagmiphotos.backfill import reconcile_orphans as ro


def test_plan_shard_chunks_groups_by_shard_and_caps_batch():
    ids = [f"id{i}" for i in range(50)]
    chunks = ro.plan_shard_chunks(ids, shards=3, batch=20)
    seen = []
    for shard, chunk in chunks:
        assert 0 < len(chunk) <= 20                       # never exceeds the get_by_ids cap
        assert all(shard_for(i, 3) == shard for i in chunk)  # each chunk is single-shard
        seen += chunk
    assert sorted(seen) == sorted(ids)                    # every id covered exactly once


def test_existing_ids_aggregates_found_across_shards():
    ids = [f"id{i}" for i in range(30)]
    present = set(ids[:20])

    def check(shard, chunk):                              # injected get_by_ids stand-in
        return {i for i in chunk if i in present}

    found = ro.existing_ids(check, ids, shards=3)
    assert found == present
    assert [i for i in ids if i not in found] == ids[20:]  # the rest are orphans


def test_existing_ids_empty_when_nothing_present():
    ids = [f"id{i}" for i in range(10)]
    found = ro.existing_ids(lambda shard, chunk: set(), ids, shards=3)
    assert found == set()
