import { it, expect } from "vitest";
// The cross-language constants contract at the repo root. The Python backfill
// pins its side in projects/common/tests/test_contract.py; a drift on either
// side must fail tests.
import contract from "../../../contract.json";
import { FLOOR_SIM_MAX, FLOOR_SIM_MIN } from "../src/floor";
import { DEFAULT_CACHE_TOLERANCE } from "../src/handler";
import { BGE_MODEL } from "../src/embed";

it("floor constants match contract.json", () => {
  expect(FLOOR_SIM_MAX).toBe(contract.floor_sim_max);
  expect(FLOOR_SIM_MIN).toBe(contract.floor_sim_min);
});

it("default cache tolerance matches contract.json", () => {
  expect(DEFAULT_CACHE_TOLERANCE).toBe(contract.default_cache_tolerance);
});

it("edge BGE model id matches contract.json (same embedding space as backfill)", () => {
  expect(BGE_MODEL).toBe(contract.bge_model_workers_ai);
});

import { fnv1a32, shardFor } from "../src/shard";

it("shard routing matches the contract fixtures", () => {
  for (const [id, shard] of Object.entries(contract.shard_fixtures)) {
    expect(shardFor(id, contract.vectorize_shards)).toBe(shard);
  }
});

it("fnv1a32 reference value", () => {
  expect(fnv1a32("demo-1")).toBe(207613968);
});
