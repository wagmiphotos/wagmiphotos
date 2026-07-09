import { it, expect } from "vitest";
import { tryByokGenerate, monthKey, type ByokCfg } from "../src/byok";
import { encryptSecret } from "../src/crypto";
import { ProviderAuthError, type ImageProvider } from "../src/providers";
import { fakeServices } from "./fakes";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const NOW = 1783468800; // 2026-07-08T00:00:00Z -> monthKey "2026-07"
const PNG = new Uint8Array([0x89, 0x50]).buffer;

const cleanModeration = (async () =>
  new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 })
) as unknown as typeof fetch;

function okProvider(): ImageProvider {
  return { generate: async () => ({ bytes: PNG, mime: "image/png" }), validateKey: async () => true };
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

function cfg(over: Partial<ByokCfg> = {}): ByokCfg {
  return {
    kek: KEK, moderationKey: "sk-operator", bucket: { put: async () => ({}) },
    publicUrlBase: "https://byok.example", now: () => NOW,
    fetchFn: cleanModeration, providerFor: () => okProvider(), uuid: () => "gen-1",
    ...over,
  };
}

it("monthKey is the UTC calendar month", () => {
  expect(monthKey(NOW)).toBe("2026-07");
});

it("happy path: moderates, reserves, generates, persists, indexes, accounts", async () => {
  const s = await seededServices();
  const puts: string[] = [];
  const out = await tryByokGenerate({ userId: "u1", prompt: "a red fox", vec: [0.1] }, s,
    cfg({ bucket: { put: async (key) => { puts.push(key); return {}; } } }));
  expect(out.kind).toBe("generated");
  if (out.kind !== "generated") return;
  expect(puts).toEqual(["byok/gen-1/original.png"]);
  expect(out.asset.source).toBe("byok");
  expect(out.asset.source_url).toBe("https://byok.example/byok/gen-1/original.png");
  expect(out.used).toBe(1);
  expect(out.cap).toBe(50);
  expect(out.estSpendUsd).toBeCloseTo(0.055);
  expect((s as any)._upserted).toEqual([{ id: "gen-1", vector: [0.1] }]);
  // audit trail: the D1 row records who generated it (never exposed on reads)
  expect((s as any)._generatedInserts[0].createdBy).toBe("u1");
  expect(out.asset).not.toHaveProperty("created_by");
});

it("skipped when no key row / disabled / cfg incomplete", async () => {
  const bare = fakeServices();
  expect((await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, bare, cfg())).kind).toBe("skipped");
  const off = await seededServices({ enabled: false });
  expect((await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, off, cfg())).kind).toBe("skipped");
  const s = await seededServices();
  expect((await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ kek: undefined }))).kind).toBe("skipped");
});

it("denylist term short-circuits before moderation and provider", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "pikachu at dawn", vec: [] }, s,
    cfg({ fetchFn: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch }));
  expect(out).toEqual({ kind: "content_policy", category: "denylist:pikachu" });
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("moderation flag -> content_policy, nothing reserved", async () => {
  const s = await seededServices();
  const flagged = (async () =>
    new Response(JSON.stringify({ results: [{ flagged: true, categories: { violence: true } }] }), { status: 200 })
  ) as unknown as typeof fetch;
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ fetchFn: flagged }));
  expect(out).toEqual({ kind: "content_policy", category: "violence" });
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("undecryptable key (KEK rotated) disables the key with decrypt_failed", async () => {
  const OTHER_KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));
  const s = await seededServices();
  (s as any)._byokRows.get("u1").key_ciphertext = await encryptSecret("sk-user-key", OTHER_KEK);
  const out = await tryByokGenerate({ userId: "u1", prompt: "a red fox", vec: [0.1] }, s, cfg());
  expect(out.kind).toBe("provider_error");
  const row = (s as any)._byokRows.get("u1");
  expect(row.enabled).toBe(0);
  expect(row.last_error).toBe("decrypt_failed");
  // decrypt happens before the quota reserve: nothing to refund
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("moderation outage -> provider_error (fail closed), nothing reserved", async () => {
  const s = await seededServices();
  const down = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ fetchFn: down }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("gmicloud user without an operator moderation key is skipped (never unmoderated)", async () => {
  const s = await seededServices({ provider: "gmicloud" });
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s, cfg({ moderationKey: undefined }));
  expect(out.kind).toBe("skipped");
});

it("cap reached -> cap_reached, no provider call", async () => {
  const s = await seededServices({ cap: 1 });
  await s.byok.reserve("u1", "2026-07", 1); // spend the month
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ providerFor: () => ({ generate: async () => { throw new Error("must not generate"); }, validateKey: async () => true }) }));
  expect(out.kind).toBe("cap_reached");
});

it("provider failure refunds the reservation", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ providerFor: () => ({ generate: async () => { throw new Error("boom"); }, validateKey: async () => true }) }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
  const row = (s as any)._byokRows.get("u1");
  expect(row.enabled).toBe(1);
  expect(row.last_error).toBeNull();
});

it("provider 401 refunds, disables the key, and records last_error", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ providerFor: () => ({ generate: async () => { throw new ProviderAuthError("401"); }, validateKey: async () => true }) }));
  expect(out.kind).toBe("provider_error");
  const row = (s as any)._byokRows.get("u1");
  expect(row.enabled).toBe(0);
  expect(row.last_error).toBe("provider_auth_failed");
});

it("R2 put failure refunds", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "x", vec: [] }, s,
    cfg({ bucket: { put: async () => { throw new Error("r2 down"); } } }));
  expect(out.kind).toBe("provider_error");
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(0);
});

it("vector upsert failure does NOT fail the request (post-spend)", async () => {
  const s = await seededServices();
  (s.vectorize as any).upsert = async () => { throw new Error("vectorize offline"); };
  const out = await tryByokGenerate({ userId: "u1", prompt: "a red fox", vec: [0.1] }, s, cfg());
  expect(out.kind).toBe("generated");
});

it("post-persist bookkeeping failure does NOT refund or fail the request", async () => {
  const s = await seededServices();
  (s.byok as any).getUsage = async () => { throw new Error("d1 read hiccup"); };
  const out = await tryByokGenerate({ userId: "u1", prompt: "a red fox", vec: [0.1] }, s, cfg());
  expect(out.kind).toBe("generated");
  if (out.kind !== "generated") return;
  expect(out.used).toBe(1); // fallback numbers when the read fails
  expect(out.estSpendUsd).toBeCloseTo(0.055);
  expect((s as any)._byokUsage.get("u1:2026-07").count).toBe(1); // reservation NOT refunded
});

it("scoped generation: insertGenerated carries collectionId and the namespace gets a best-effort upsert", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate(
    { userId: "u1", prompt: "a cat, watercolor style", vec: [0.1], collectionId: "col_abc" }, s, cfg()
  );
  expect(out.kind).toBe("generated");
  expect((s as any)._generatedInserts[0].collectionId).toBe("col_abc");
  expect((s as any)._upserted).toEqual([{ id: "gen-1", vector: [0.1] }]);          // main shard write unchanged
  expect((s as any)._nsUpserted).toEqual([{ id: "gen-1", vector: [0.1], namespace: "col_abc" }]);
});

it("scoped generation: namespace upsert failure does not fail the request", async () => {
  const s = await seededServices();
  s.vectorize.upsertNamespace = async () => { throw new Error("vectorize down"); };
  const out = await tryByokGenerate(
    { userId: "u1", prompt: "p", vec: [0.1], collectionId: "col_abc" }, s, cfg()
  );
  expect(out.kind).toBe("generated");
});

it("global generation passes collectionId null and skips the namespace write", async () => {
  const s = await seededServices();
  const out = await tryByokGenerate({ userId: "u1", prompt: "p", vec: [0.1] }, s, cfg());
  expect(out.kind).toBe("generated");
  expect((s as any)._generatedInserts[0].collectionId).toBeNull();
  expect((s as any)._nsUpserted).toEqual([]);
});
