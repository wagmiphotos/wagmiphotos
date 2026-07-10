import { it, expect } from "vitest";
import {
  startGeneration, driveGeneration, sweepGenerations, monthKey,
  SWEEP_ABANDON_SEC, type GenJobsCfg,
} from "../src/generation-jobs";
import { encryptSecret } from "../src/crypto";
import { ProviderAuthError, type AsyncImageProvider, type SyncImageProvider } from "../src/providers";
import { fakeServices } from "./fakes";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const NOW = 1783468800; // 2026-07-08T00:00:00Z -> monthKey "2026-07"
const MONTH = monthKey(NOW);
const PNG = new Uint8Array([0x89, 0x50]).buffer;
// fakeServices().generations.create() stamps this fixed created_at on every row.
const CREATED_AT = "2026-07-10 00:00:00";
const CREATED_EPOCH = Math.floor(Date.parse(CREATED_AT.replace(" ", "T") + "Z") / 1000);

const cleanModeration = (async () =>
  new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 })
) as unknown as typeof fetch;

function okSyncProvider(): SyncImageProvider {
  return { mode: "sync", generate: async () => ({ bytes: PNG, mime: "image/png" }), validateKey: async () => true };
}

async function seededServices(over: Partial<{ enabled: boolean; cap: number; provider: string }> = {}) {
  const s = fakeServices();
  await s.byok.put({
    userId: "u1", provider: over.provider ?? "openai",
    keyCiphertext: await encryptSecret("sk-user-key", KEK), keyLast4: "-key",
    monthlyCap: over.cap ?? 50, enabled: over.enabled ?? true,
  });
  return s;
}

function cfg(over: Partial<GenJobsCfg> = {}): GenJobsCfg {
  return {
    kek: KEK, moderationKey: "sk-operator", bucket: { put: async () => ({}) },
    publicUrlBase: "https://byok.example", now: () => NOW,
    fetchFn: cleanModeration, providerFor: () => okSyncProvider(), uuid: () => "gen-1",
    ...over,
  };
}

// --- startGeneration gates (mirror byok.test.ts coverage on the new module) ---

it("1. missing kek/bucket/publicUrlBase -> byok_unconfigured, nothing reserved", async () => {
  const s = await seededServices();
  expect((await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, cfg({ kek: undefined }))).kind)
    .toBe("byok_unconfigured");
  expect((await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, cfg({ bucket: undefined }))).kind)
    .toBe("byok_unconfigured");
  expect((await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, cfg({ publicUrlBase: undefined }))).kind)
    .toBe("byok_unconfigured");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
});

it("2. no byok row / disabled row -> byok_unconfigured", async () => {
  const bare = fakeServices();
  expect((await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, bare, cfg())).kind)
    .toBe("byok_unconfigured");
  const off = await seededServices({ enabled: false });
  expect((await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, off, cfg())).kind)
    .toBe("byok_unconfigured");
});

it("3. denylisted prompt -> content_policy denylist:<term>, no reserve", async () => {
  const s = await seededServices();
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "pikachu at dawn" }, s,
    cfg({ fetchFn: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch }));
  expect(out).toEqual({ kind: "content_policy", category: "denylist:pikachu" });
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
});

it("4. moderation flags -> content_policy, no reserve", async () => {
  const s = await seededServices();
  const flagged = (async () =>
    new Response(JSON.stringify({ results: [{ flagged: true, categories: { violence: true } }] }), { status: 200 })
  ) as unknown as typeof fetch;
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, cfg({ fetchFn: flagged }));
  expect(out).toEqual({ kind: "content_policy", category: "violence" });
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
});

it("5. moderation endpoint down -> provider_error (fail closed), no reserve", async () => {
  const s = await seededServices();
  const down = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, cfg({ fetchFn: down }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
});

it("6. cap spent -> cap_reached with used/cap, no provider call", async () => {
  const s = await seededServices({ cap: 1 });
  await s.byok.reserve("u1", MONTH, 1); // spend the month
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s,
    cfg({ providerFor: () => ({ mode: "sync", generate: async () => { throw new Error("must not generate"); }, validateKey: async () => true }) }));
  expect(out).toEqual({ kind: "cap_reached", used: 1, cap: 1 });
});

it("7. decrypt failure (KEK rotated) -> provider_error + byok.disable(decrypt_failed), no reserve", async () => {
  const OTHER_KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));
  const s = await seededServices();
  (s as any)._byokRows.get("u1").key_ciphertext = await encryptSecret("sk-user-key", OTHER_KEK);
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "a red fox" }, s, cfg());
  expect(out.kind).toBe("provider_error");
  const row = (s as any)._byokRows.get("u1");
  expect(row.enabled).toBe(0);
  expect(row.last_error).toBe("decrypt_failed");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
});

// --- async provider (gmicloud row) ---

it("8. async happy path: job row generating w/ provider_job_id, accepted, reservation held", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const submitCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async (prompt) => { submitCalls.push(prompt); return "job-8"; },
    check: async () => { throw new Error("must not be called"); },
    validateKey: async () => true,
  };
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "a red fox" }, s,
    cfg({ providerFor: () => provider, uuid: () => "g8" }));
  expect(out.kind).toBe("accepted");
  if (out.kind !== "accepted") return;
  expect(submitCalls).toEqual(["a red fox"]);
  expect(out.row.status).toBe("generating");
  expect(out.row.provider_job_id).toBe("job-8");
  expect(out.used).toBe(1);
  expect(out.cap).toBe(50);
  expect(out.estSpendUsd).toBe(0); // real spend so far is $0 — the async job hasn't billed yet
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(1);
});

it("9. async submit throws -> job failed, reservation refunded, provider_error", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => { throw new Error("submit boom"); },
    check: async () => { throw new Error("must not be called"); },
    validateKey: async () => true,
  };
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s,
    cfg({ providerFor: () => provider, uuid: () => "g9" }));
  expect(out.kind).toBe("provider_error");
  const row = (s as any)._generationRows.get("gen_g9");
  expect(row.status).toBe("failed");
  expect(row.error).toBe("provider submit failed");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
  const byokRow = (s as any)._byokRows.get("u1");
  expect(byokRow.enabled).toBe(1); // non-auth failure: key stays enabled
});

it("10. async submit throws ProviderAuthError -> failed, refunded, key disabled", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => { throw new ProviderAuthError("401"); },
    check: async () => { throw new Error("must not be called"); },
    validateKey: async () => true,
  };
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s,
    cfg({ providerFor: () => provider, uuid: () => "g10" }));
  expect(out.kind).toBe("provider_error");
  const row = (s as any)._generationRows.get("gen_g10");
  expect(row.status).toBe("failed");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
  const byokRow = (s as any)._byokRows.get("u1");
  expect(byokRow.enabled).toBe(0);
  expect(byokRow.last_error).toBe("provider_auth_failed");
});

// --- sync provider (openai row, cfg.waitUntil omitted so it runs inline) ---

it("11. sync happy path: publishes, succeeds, spends, namespace-only vector write", async () => {
  const s = await seededServices({ provider: "openai" });
  const generateCalls: string[] = [];
  const puts: { key: string; contentType?: string }[] = [];
  const provider: SyncImageProvider = {
    mode: "sync",
    generate: async (prompt) => { generateCalls.push(prompt); return { bytes: PNG, mime: "image/webp" }; },
    validateKey: async () => true,
  };
  const out = await startGeneration({ userId: "u1", collectionId: "col_scope1", prompt: "a red fox" }, s,
    cfg({
      providerFor: () => provider, uuid: () => "g11",
      bucket: { put: async (key, _v, opts) => { puts.push({ key, contentType: opts?.httpMetadata?.contentType }); return {}; } },
    }));
  expect(generateCalls).toEqual(["a red fox"]);
  expect(out.kind).toBe("accepted");
  if (out.kind !== "accepted") return;
  expect(out.row.status).toBe("succeeded");
  expect(out.row.asset_id).toBe("g11");
  expect(puts).toEqual([{ key: "byok/g11/original.webp", contentType: "image/webp" }]);
  const inserted = (s as any)._generatedInserts[0];
  expect(inserted.createdBy).toBe("u1");
  expect(inserted.collectionId).toBe("col_scope1");
  expect((await s.byok.getUsage("u1", MONTH)).est_spend_usd).toBeCloseTo(0.04);
  expect(out.used).toBe(1);
  expect(out.estSpendUsd).toBeCloseTo(0.04);
  // namespace-ONLY vector write (spec decision 2): the shared-library shard stays untouched
  expect((s as any)._nsUpserted).toEqual([{ id: "g11", vector: [0.1, 0.2, 0.3], namespace: "col_scope1" }]);
  expect((s as any)._upserted).toEqual([]);
});

it("12. sync generate() throws -> job failed + refunded", async () => {
  const s = await seededServices({ provider: "openai" });
  const provider: SyncImageProvider = {
    mode: "sync",
    generate: async () => { throw new Error("boom"); },
    validateKey: async () => true,
  };
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s,
    cfg({ providerFor: () => provider, uuid: () => "g12" }));
  // The sync job runs to completion inline (waitUntil omitted) before this
  // returns, but the outcome kind still reads "accepted" — the job was
  // accepted for processing; failure surfaces on the job row, not here.
  expect(out.kind).toBe("accepted");
  if (out.kind !== "accepted") return;
  expect(out.row.status).toBe("failed");
  expect(out.used).toBe(0);
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
  expect((s as any)._generatedInserts).toEqual([]);
});

// --- driveGeneration (async job in 'generating') ---

it("13. check pending -> row stays generating; claim released for a second drive", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-13",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "pending" }; },
    validateKey: async () => true,
  };
  const startCfg = cfg({ providerFor: () => provider, uuid: () => "g13" });
  const started = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, startCfg);
  expect(started.kind).toBe("accepted");
  const genId = "gen_g13";

  const row1 = await driveGeneration(genId, s, startCfg);
  expect(row1?.status).toBe("generating");
  expect((s as any)._generationRows.get(genId).claimed_at).toBeNull();
  expect(checkCalls).toEqual(["job-13"]);

  const row2 = await driveGeneration(genId, s, startCfg);
  expect(row2?.status).toBe("generating");
  expect(checkCalls).toEqual(["job-13", "job-13"]); // second drive proceeded (claim wasn't stuck)
});

it("14. check done -> publishes exactly like the sync path; second drive returns succeeded row without provider calls", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const checkCalls: string[] = [];
  const puts: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-14",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "done", image: { bytes: PNG, mime: "image/webp" } }; },
    validateKey: async () => true,
  };
  const startCfg = cfg({
    providerFor: () => provider, uuid: () => "g14",
    bucket: { put: async (key) => { puts.push(key); return {}; } },
  });
  await startGeneration({ userId: "u1", collectionId: "col_scope2", prompt: "x" }, s, startCfg);
  const genId = "gen_g14";

  const row1 = await driveGeneration(genId, s, startCfg);
  expect(row1?.status).toBe("succeeded");
  expect(row1?.asset_id).toBe("g14");
  expect(puts).toEqual(["byok/g14/original.webp"]);
  expect((s as any)._generatedInserts[0].collectionId).toBe("col_scope2");
  expect((s as any)._generatedInserts[0].createdBy).toBe("u1");
  expect((s as any)._nsUpserted).toEqual([{ id: "g14", vector: [0.1, 0.2, 0.3], namespace: "col_scope2" }]);
  expect((s as any)._upserted).toEqual([]);
  expect((await s.byok.getUsage("u1", MONTH)).est_spend_usd).toBeCloseTo(0.055);

  const row2 = await driveGeneration(genId, s, startCfg);
  expect(row2?.status).toBe("succeeded");
  expect(checkCalls).toEqual(["job-14"]); // second drive never touched the provider
});

it("15. check failed -> job failed + refunded once; drive again does not refund twice", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-15",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "failed", error: "nsfw content" }; },
    validateKey: async () => true,
  };
  const startCfg = cfg({ providerFor: () => provider, uuid: () => "g15" });
  await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, startCfg);
  const genId = "gen_g15";

  const row1 = await driveGeneration(genId, s, startCfg);
  expect(row1?.status).toBe("failed");
  expect(row1?.error).toBe("nsfw content");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);

  const row2 = await driveGeneration(genId, s, startCfg);
  expect(row2?.status).toBe("failed");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0); // no second refund
  expect(checkCalls).toEqual(["job-15"]); // second drive never touched the provider
});

it("16. check throws (network) -> claim released, job stays open, no refund", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-16",
    check: async (jobId) => { checkCalls.push(jobId); throw new Error("network blip"); },
    validateKey: async () => true,
  };
  const startCfg = cfg({ providerFor: () => provider, uuid: () => "g16" });
  await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, startCfg);
  const genId = "gen_g16";

  const row = await driveGeneration(genId, s, startCfg);
  expect(row?.status).toBe("generating");
  expect((s as any)._generationRows.get(genId).claimed_at).toBeNull();
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(1); // no refund on a transient error
  expect(checkCalls).toEqual(["job-16"]);
});

it("17. check throws ProviderAuthError -> failed + refunded + key disabled", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-17",
    check: async () => { throw new ProviderAuthError("401"); },
    validateKey: async () => true,
  };
  const startCfg = cfg({ providerFor: () => provider, uuid: () => "g17" });
  await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, startCfg);
  const genId = "gen_g17";

  const row = await driveGeneration(genId, s, startCfg);
  expect(row?.status).toBe("failed");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
  const byokRow = (s as any)._byokRows.get("u1");
  expect(byokRow.enabled).toBe(0);
  expect(byokRow.last_error).toBe("provider_auth_failed");
});

it("18. concurrent drive: a held claim wins; the second caller returns without calling check", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-18",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "pending" }; },
    validateKey: async () => true,
  };
  const startCfg = cfg({ providerFor: () => provider, uuid: () => "g18" });
  await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s, startCfg);
  const genId = "gen_g18";

  // Simulate a concurrent in-flight drive that already holds the claim.
  expect(await s.generations.claim(genId)).toBe(true);

  const row = await driveGeneration(genId, s, startCfg);
  expect(row?.status).toBe("generating");
  expect(checkCalls).toEqual([]); // the second caller never reached the provider
});

// --- sweepGenerations ---

it("19. sweep: open job younger than SWEEP_ABANDON_SEC with provider_job_id gets driven", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  await s.generations.create({ id: "gen_sweep19", userId: "u1", collectionId: "col_1", prompt: "x", provider: "gmicloud", month: MONTH });
  await s.generations.setProviderJob("gen_sweep19", "job-19");
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-19",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "pending" }; },
    validateKey: async () => true,
  };
  const sweepCfg = cfg({ providerFor: () => provider, now: () => CREATED_EPOCH + 100 });
  await sweepGenerations(s, sweepCfg);
  expect(checkCalls).toEqual(["job-19"]);
  expect((s as any)._generationRows.get("gen_sweep19").status).toBe("generating");
});

it("20. sweep: open job older than SWEEP_ABANDON_SEC is failed + refunded, not driven", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  await s.generations.create({ id: "gen_sweep20", userId: "u1", collectionId: "col_1", prompt: "x", provider: "gmicloud", month: MONTH });
  await s.generations.setProviderJob("gen_sweep20", "job-20");
  await s.byok.reserve("u1", MONTH, 50); // the quota unit this job holds
  const checkCalls: string[] = [];
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-20",
    check: async (jobId) => { checkCalls.push(jobId); return { state: "pending" }; },
    validateKey: async () => true,
  };
  const sweepCfg = cfg({ providerFor: () => provider, now: () => CREATED_EPOCH + SWEEP_ABANDON_SEC + 100 });
  await sweepGenerations(s, sweepCfg);
  expect(checkCalls).toEqual([]); // abandoned directly — never driven
  const row = (s as any)._generationRows.get("gen_sweep20");
  expect(row.status).toBe("failed");
  expect(row.error).toBe("abandoned: no completion within the retention window");
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(0);
});

it("21. sweep: sync job (no provider_job_id) within the window is left untouched", async () => {
  const s = await seededServices({ provider: "openai" });
  await s.generations.create({ id: "gen_sweep21", userId: "u1", collectionId: "col_1", prompt: "x", provider: "openai", month: MONTH });
  await s.byok.reserve("u1", MONTH, 50);
  const sweepCfg = cfg({
    providerFor: () => { throw new Error("must not be called"); },
    now: () => CREATED_EPOCH + 100,
  });
  await sweepGenerations(s, sweepCfg);
  const row = (s as any)._generationRows.get("gen_sweep21");
  expect(row.status).toBe("queued");
  expect(row.provider_job_id).toBeNull();
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(1); // untouched: no refund
});

// --- terminal failure is durable-aware: never refund a delivered asset ---

// Mirrors the module's assetIdFor() so tests derive the same id it would.
const assetIdFor = (genId: string): string => genId.startsWith("gen_") ? genId.slice(4) : `${genId}-a`;

it("22. sync path: generations.succeed() throws once -> recovers to succeeded, no refund, spend recorded once", async () => {
  const s = await seededServices({ provider: "openai" });
  const origSucceed = s.generations.succeed.bind(s.generations);
  let succeedCalls = 0;
  s.generations.succeed = async (id, assetId) => {
    succeedCalls += 1;
    if (succeedCalls === 1) throw new Error("d1 hiccup");
    return origSucceed(id, assetId);
  };
  const provider: SyncImageProvider = {
    mode: "sync",
    generate: async () => ({ bytes: PNG, mime: "image/webp" }),
    validateKey: async () => true,
  };
  const out = await startGeneration({ userId: "u1", collectionId: "col_1", prompt: "x" }, s,
    cfg({ providerFor: () => provider, uuid: () => "g22" }));
  expect(out.kind).toBe("accepted");
  if (out.kind !== "accepted") return;
  const row = (s as any)._generationRows.get("gen_g22");
  expect(row.status).toBe("succeeded");
  expect(row.asset_id).toBe(assetIdFor("gen_g22"));
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(1); // NO refund
  expect((await s.byok.getUsage("u1", MONTH)).est_spend_usd).toBeCloseTo(0.04); // recorded exactly once
  expect((s as any)._generatedInserts).toHaveLength(1);
  expect((s as any)._generatedInserts[0].id).toBe(assetIdFor("gen_g22"));
});

it("23. sweep abandon racing a mid-publish drive: asset already durable -> recovers to succeeded, no refund", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const provider: AsyncImageProvider = {
    mode: "async",
    submit: async () => "job-23",
    check: async () => { throw new Error("must not be called — abandon short-circuits before driving"); },
    validateKey: async () => true,
  };
  const startCfg = cfg({ providerFor: () => provider, uuid: () => "g23" });
  await startGeneration({ userId: "u1", collectionId: "col_scope23", prompt: "x" }, s, startCfg);
  const genId = "gen_g23";
  const assetId = assetIdFor(genId);

  // Simulate a drive that inserted the durable asset but crashed/was abandoned
  // before generations.succeed() transitioned the row.
  await s.assets.insertGenerated({
    id: assetId, prompt: "x", sourceUrl: "https://byok.example/byok/g23/original.png", mime: "image/png",
    width: 1024, height: 1024, modelUsed: "gpt-image-2-generate", provider: "gmicloud", priceUsd: 0.055,
    createdBy: "u1", collectionId: "col_scope23",
  });

  const row = (s as any)._generationRows.get(genId);
  row.created_at = "2020-01-01 00:00:00"; // well past SWEEP_ABANDON_SEC
  row.claimed_at = null;

  const sweepCfg = cfg({ providerFor: () => provider, now: () => CREATED_EPOCH + SWEEP_ABANDON_SEC + 100 });
  await sweepGenerations(s, sweepCfg);

  expect(row.status).toBe("succeeded"); // not failed
  expect(row.asset_id).toBe(assetId);
  expect((await s.byok.getUsage("u1", MONTH)).count).toBe(1); // no refund
});
