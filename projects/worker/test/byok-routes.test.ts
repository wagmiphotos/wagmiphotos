import { it, expect } from "vitest";
import { handlePutByok, handlePatchByok, handleDeleteByok, byokView } from "../src/byok-routes";
import { decryptSecret } from "../src/crypto";
import { fakeServices } from "./fakes";
import type { Env } from "../src/types";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const env = { BYOK_KEK: KEK } as Env;

function sessionServices(userId = "u1") {
  const s = fakeServices();
  s.sessions.resolve = async () => ({ user_id: userId });
  return s;
}
const put = (body: unknown) => new Request("https://x/v1/byok", {
  method: "PUT", headers: { Cookie: "wagmi_session=tok", "Content-Type": "application/json" }, body: JSON.stringify(body),
});

it("PUT requires a session", async () => {
  const s = fakeServices(); // resolve -> null
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  expect(res.status).toBe(401);
});

it("PUT rejects a bearer-only request: no cookie session, no key management via sc- keys", async () => {
  const s = fakeServices(); // sessions.resolve -> null (unset)
  const req = new Request("https://x/v1/byok", {
    method: "PUT",
    headers: { Authorization: "Bearer sc-whatever", "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai", api_key: "sk-user-12345" }),
  });
  const res = await handlePutByok(req, env, s, async () => true);
  expect(res.status).toBe(401);
  expect((s as any)._byokRows.size).toBe(0);
});

it("PUT validates and stores the key encrypted with last4 + defaults", async () => {
  const s = sessionServices();
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  expect(res.status).toBe(200);
  const row = (s as any)._byokRows.get("u1");
  expect(row.key_last4).toBe("2345");
  expect(row.monthly_cap).toBe(50);
  expect(row.key_ciphertext).not.toContain("sk-user");
  expect(await decryptSecret(row.key_ciphertext, KEK)).toBe("sk-user-12345");
  const body: any = await res.json();
  expect(body.byok.key_last4).toBe("2345");
  expect(body.byok.price_per_image).toBeCloseTo(0.04);
});

it("PUT rejects a key the provider refuses", async () => {
  const s = sessionServices();
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-bad-12345" }), env, s, async () => false);
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("key_rejected");
  expect((s as any)._byokRows.size).toBe(0);
});

it("PUT trims pasted whitespace off the api_key before validating and storing", async () => {
  const s: any = fakeServices();
  let validatedWith = "";
  const res = await handlePutByok(put({ provider: "openai", api_key: "  sk-user-12345\n" }), env, s,
    async (_p, k) => { validatedWith = k; return true; });
  expect(res.status).toBe(200);
  expect(validatedWith).toBe("sk-user-12345"); // no clipboard whitespace reaches the provider
  expect(s._byokRows.get("usr_1").key_last4).toBe("2345");
});

it("PUT validates provider / api_key / monthly_cap / enabled", async () => {
  const s = sessionServices();
  const v = async () => true;
  expect((await handlePutByok(put({ provider: "google", api_key: "sk-user-12345" }), env, s, v)).status).toBe(422);
  expect((await handlePutByok(put({ provider: "openai", api_key: "short" }), env, s, v)).status).toBe(422);
  expect((await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345", monthly_cap: 0 }), env, s, v)).status).toBe(422);
  expect((await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345", enabled: "yes" }), env, s, v)).status).toBe(422);
});

it("PUT 503s without BYOK_KEK configured", async () => {
  const s = sessionServices();
  const res = await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), {} as Env, s, async () => true);
  expect(res.status).toBe(503);
});

it("PATCH updates cap/enabled; 404 without a key", async () => {
  const s = sessionServices();
  const patch = (body: unknown) => new Request("https://x/v1/byok", { method: "PATCH", headers: { Cookie: "wagmi_session=tok" }, body: JSON.stringify(body) });
  expect((await handlePatchByok(patch({ monthly_cap: 10 }), env, s)).status).toBe(404);
  await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  const res = await handlePatchByok(patch({ monthly_cap: 10, enabled: false }), env, s);
  expect(res.status).toBe(200);
  const row = (s as any)._byokRows.get("u1");
  expect(row.monthly_cap).toBe(10);
  expect(row.enabled).toBe(0);
});

it("DELETE removes the key; usage rows survive", async () => {
  const s = sessionServices();
  await handlePutByok(put({ provider: "openai", api_key: "sk-user-12345" }), env, s, async () => true);
  await s.byok.reserve("u1", "2026-07", 50);
  const res = await handleDeleteByok(new Request("https://x/v1/byok", { method: "DELETE", headers: { Cookie: "wagmi_session=tok" } }), env, s);
  expect(res.status).toBe(200);
  expect((s as any)._byokRows.size).toBe(0);
  expect((await s.byok.getUsage("u1", "2026-07")).count).toBe(1);
});

it("byokView reports usage and price; null without a key", async () => {
  const s = sessionServices();
  const NOW = 1783468800; // 2026-07-08 UTC -> monthKey "2026-07"
  expect(await byokView(s, "u1", NOW)).toBeNull();
  await handlePutByok(put({ provider: "gmicloud", api_key: "gmi-key-12345" }), env, s, async () => true);
  await s.byok.reserve("u1", "2026-07", 50);
  await s.byok.addSpend("u1", "2026-07", 0.055);
  const v: any = await byokView(s, "u1", NOW);
  expect(v).toMatchObject({ provider: "gmicloud", used_this_month: 1, monthly_cap: 50, enabled: true, last_error: null });
  expect(v.est_spend_usd).toBeCloseTo(0.06); // rounded to cents
  expect(v.price_per_image).toBeCloseTo(0.055);
});
