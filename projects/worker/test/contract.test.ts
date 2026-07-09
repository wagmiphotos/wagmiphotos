import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

it("byok provider pins: fixed model + price estimate per provider", () => {
  expect(contract.byok_providers.openai.model).toBe("gpt-image-2");
  expect(contract.byok_providers.gmicloud.model).toBe("gpt-image-2-generate");
  expect(contract.byok_providers.openai.price_per_image_usd).toBeGreaterThan(0);
  expect(contract.byok_providers.gmicloud.price_per_image_usd).toBeGreaterThan(0);
});

it("denylist_terms is a non-empty lowercase list", () => {
  expect(contract.denylist_terms.length).toBeGreaterThan(20);
  for (const t of contract.denylist_terms) expect(t).toBe(t.toLowerCase().trim());
});

it("wrangler.toml [[vectorize]] shard bindings match contract.json (shard count + index names)", () => {
  const toml = readFileSync(join(__dirname, "../wrangler.toml"), "utf8");
  const blocks = toml.split("[[vectorize]]").slice(1);
  // Only the numbered VECTORIZE_<n> blocks are shards; VECTORIZE_COLL is a
  // separate namespaced index (checked below) and isn't part of the shard count.
  const shardBlocks = blocks.filter((b) => /binding\s*=\s*"VECTORIZE_\d+"/.test(b));
  expect(
    shardBlocks.length,
    `wrangler.toml has ${shardBlocks.length} shard [[vectorize]] block(s), contract.json vectorize_shards is ${contract.vectorize_shards}`,
  ).toBe(contract.vectorize_shards);

  const parsed = shardBlocks.map((block, i) => {
    const bindingMatch = block.match(/binding\s*=\s*"VECTORIZE_(\d+)"/);
    const indexMatch = block.match(/index_name\s*=\s*"([^"]+)"/);
    expect(bindingMatch, `[[vectorize]] shard block ${i} in wrangler.toml is missing a binding = "VECTORIZE_<n>" line`).not.toBeNull();
    expect(indexMatch, `[[vectorize]] shard block ${i} in wrangler.toml is missing an index_name = "..." line`).not.toBeNull();
    return { shard: Number(bindingMatch![1]), indexName: indexMatch![1] };
  });

  for (let i = 0; i < contract.vectorize_shards; i++) {
    const expectedBinding = `VECTORIZE_${i}`;
    const expectedIndexName = `${contract.vectorize_index_prefix}${i}`;
    const entry = parsed.find((p) => p.shard === i);
    expect(
      entry,
      `wrangler.toml has no [[vectorize]] block with binding = "${expectedBinding}"`,
    ).toBeDefined();
    expect(
      entry!.indexName,
      `wrangler.toml binding "${expectedBinding}" has index_name = "${entry!.indexName}", expected "${expectedIndexName}"`,
    ).toBe(expectedIndexName);
  }
});

it("wrangler.toml has a VECTORIZE_COLL [[vectorize]] block for the namespaced collections index", () => {
  const toml = readFileSync(join(__dirname, "../wrangler.toml"), "utf8");
  const blocks = toml.split("[[vectorize]]").slice(1);
  const collBlock = blocks.find((b) => /binding\s*=\s*"VECTORIZE_COLL"/.test(b));
  expect(collBlock, 'wrangler.toml has no [[vectorize]] block with binding = "VECTORIZE_COLL"').toBeDefined();
  expect(collBlock).toMatch(/index_name\s*=\s*"wagmiphotos-coll"/);
});
