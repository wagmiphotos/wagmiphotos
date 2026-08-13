import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The cross-language constants contract at the repo root. The Python backfill
// pins its side in projects/common/tests/test_contract.py; a drift on either
// side must fail tests.
import contract from "../../../contract.json";
import { FLOOR_SIM_MAX, FLOOR_SIM_MIN, LIBRARY_FLOOR_SIM, similarityFloor } from "../src/floor";
import { DEFAULT_CACHE_TOLERANCE } from "../src/handler";
import { BGE_MODEL } from "../src/embed";

it("floor constants match contract.json", () => {
  expect(FLOOR_SIM_MAX).toBe(contract.floor_sim_max);
  expect(FLOOR_SIM_MIN).toBe(contract.floor_sim_min);
  expect(LIBRARY_FLOOR_SIM).toBe(contract.library_floor_sim);
});

it("wrangler.toml [vars] cannot override the contract-pinned floors", () => {
  // numEnv() gives deployed env vars precedence over the code defaults, so a
  // floor var in wrangler.toml silently overrides floor.ts/contract.json in
  // every deploy (this is how the 92046d9 0.87->0.84 lowering never went live).
  // Absent is fine (code default rules); present must match the contract.
  const toml = readFileSync(join(__dirname, "../wrangler.toml"), "utf8");
  const pins: [string, number][] = [
    ["FLOOR_SIM_MAX", contract.floor_sim_max],
    ["FLOOR_SIM_MIN", contract.floor_sim_min],
    ["LIBRARY_FLOOR_SIM", contract.library_floor_sim],
  ];
  for (const [name, pinned] of pins) {
    const m = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
    if (m) {
      expect(
        Number(m[1]),
        `wrangler.toml deploys ${name} = "${m[1]}", overriding the contract-pinned ${pinned}`,
      ).toBe(pinned);
    }
  }
});

it("default cache tolerance matches contract.json", () => {
  expect(DEFAULT_CACHE_TOLERANCE).toBe(contract.default_cache_tolerance);
});

// The floors are pinned in code, wrangler.toml and contract.json — but the
// numbers users actually read are hand-typed prose in the SPA docs page, and
// that is what has drifted twice: the 0.87 purge missed this page, so it kept
// advertising "≈0.85, between 0.75 and 0.87" long after the code moved to 0.84
// (effective floor 0.83). Derive the expected values so the prose cannot go
// stale silently again.
it("SPA docs quote the contract-derived floors, not superseded ones", () => {
  const html = readFileSync(join(__dirname, "../public/index.html"), "utf8");
  const effective = Number(
    similarityFloor(contract.default_cache_tolerance, contract.floor_sim_max, contract.floor_sim_min).toFixed(2),
  );

  const scale = html.match(/<div class="match-scale-labels">([\s\S]*?)<\/div>/);
  expect(scale, 'SPA docs: <div class="match-scale-labels"> block not found').not.toBeNull();
  const scaleNums = [...scale![1].matchAll(/\d\.\d+/g)].map((m) => Number(m[0]));
  for (const [label, want] of [
    ["strict end (floor_sim_max)", contract.floor_sim_max],
    ["loose end (floor_sim_min)", contract.floor_sim_min],
    ["effective server floor", effective],
  ] as [string, number][]) {
    expect(scaleNums, `SPA match scale is missing the ${label} value ${want}; it shows ${scaleNums.join(", ")}`)
      .toContain(want);
  }

  const prose = html.match(/The cosine-similarity floor a match must clear[^<]*/);
  expect(prose, "SPA docs: the fixed-floor paragraph was not found").not.toBeNull();
  const proseNums = [...prose![0].matchAll(/\d\.\d+/g)].map((m) => Number(m[0]));
  expect(proseNums, `SPA fixed-floor paragraph quotes ${proseNums.join(", ")}`)
    .toEqual([effective, contract.floor_sim_min, contract.floor_sim_max]);
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
  // openai re-pinned to gpt-image-2 via the Responses API background mode
  // (probe-verified 2026-07-10: scripts/probe-openai-background.sh — model
  // accepted, completed in 70s, revised_prompt survived verbatim).
  expect(contract.byok_providers.openai.model).toBe("gpt-image-2");
  expect(contract.byok_providers.gmicloud.model).toBe("gpt-image-2-generate");
  expect(contract.byok_providers.openai.price_per_image_usd).toBeCloseTo(0.055);
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
