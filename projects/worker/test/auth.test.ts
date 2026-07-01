import { describe, it, expect } from "vitest";
import { sha256Hex, checkAuth } from "../src/auth";
import { fakeServices } from "./fakes";

function req(token?: string) {
  const h: any = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return new Request("https://x/v1/images/generations", { method: "POST", headers: h });
}

it("sha256Hex is stable hex", async () => {
  const h = await sha256Hex("sc-secret");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(await sha256Hex("sc-secret")).toBe(h);
});

it("open when MASTER_API_KEY unset", async () => {
  const s = fakeServices();
  expect(await checkAuth(req(), {} as any, s.keys)).toBe(true);
});

it("accepts master key, rejects wrong", async () => {
  const s = fakeServices();
  const env: any = { MASTER_API_KEY: "master" };
  expect(await checkAuth(req("master"), env, s.keys)).toBe(true);
  expect(await checkAuth(req("nope"), env, s.keys)).toBe(false);
  expect(await checkAuth(req(), env, s.keys)).toBe(false);
});

it("accepts a db-registered hashed key", async () => {
  const s = fakeServices();
  const env: any = { MASTER_API_KEY: "master" };
  await s.keys.addKey(await sha256Hex("sc-user"));
  expect(await checkAuth(req("sc-user"), env, s.keys)).toBe(true);
});
