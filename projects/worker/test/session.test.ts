import { it, expect } from "vitest";
import { randomToken, parseCookies, serializeSessionCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE } from "../src/session";
import { resolveSession, resolveApiPrincipal, MASTER_USER_ID, DEV_USER_ID } from "../src/session";
import { sha256Hex } from "../src/auth";

it("randomToken is url-safe and unique", () => {
  const a = randomToken(), b = randomToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(a).not.toBe(b);
  expect(a.length).toBeGreaterThan(20);
});

it("parseCookies splits name=value pairs and tolerates blanks", () => {
  expect(parseCookies("a=1; wagmi_session=xyz; b=2")).toMatchObject({ a: "1", wagmi_session: "xyz", b: "2" });
  expect(parseCookies(null)).toEqual({});
  expect(parseCookies("")).toEqual({});
});

it("serializeSessionCookie sets HttpOnly, SameSite=Lax, Path, and Secure only when asked", () => {
  const secure = serializeSessionCookie("tok", true);
  expect(secure).toContain(`${SESSION_COOKIE}=tok`);
  expect(secure).toContain("HttpOnly");
  expect(secure).toContain("SameSite=Lax");
  expect(secure).toContain("Path=/");
  expect(secure).toContain("Secure");
  expect(serializeSessionCookie("tok", false)).not.toContain("Secure");
});

it("clearSessionCookie expires the cookie", () => {
  expect(clearSessionCookie(true)).toContain("Max-Age=0");
});

it("isSecureRequest reflects the URL scheme", () => {
  expect(isSecureRequest(new Request("https://x/"))).toBe(true);
  expect(isSecureRequest(new Request("http://localhost:8787/"))).toBe(false);
});

function reqWith({ cookie, bearer }: { cookie?: string; bearer?: string } = {}) {
  const h: Record<string, string> = {};
  if (cookie) h["Cookie"] = cookie;
  if (bearer) h["Authorization"] = `Bearer ${bearer}`;
  return new Request("https://x/v1/images/generations", { method: "POST", headers: h });
}
function fakeStores(over: any = {}) {
  return {
    sessions: { resolve: async () => null, touch: async () => {}, create: async () => {}, delete: async () => {} },
    keys: { getKeyOwner: async () => null, addKey: async () => {}, listByUser: async () => [] },
    ...over,
  };
}

it("resolveSession returns user from a valid cookie and slides TTL", async () => {
  let touched = "";
  const stores = fakeStores({ sessions: { resolve: async () => ({ user_id: "usr_9" }), touch: async (h: string) => { touched = h; } } });
  const r = await resolveSession(reqWith({ cookie: "wagmi_session=tok" }), {} as any, stores.sessions);
  expect(r).toEqual({ userId: "usr_9" });
  expect(touched).toBe(await sha256Hex("tok"));
});

it("resolveSession returns null without a cookie", async () => {
  expect(await resolveSession(reqWith(), {} as any, fakeStores().sessions)).toBeNull();
});

it("resolveApiPrincipal: master key wins", async () => {
  const r = await resolveApiPrincipal(reqWith({ bearer: "master" }), { MASTER_API_KEY: "master" } as any, fakeStores());
  expect(r).toEqual({ userId: MASTER_USER_ID });
});

it("resolveApiPrincipal: owned bearer key resolves to its owner", async () => {
  const stores = fakeStores({ keys: { getKeyOwner: async () => "usr_7", addKey: async () => {}, listByUser: async () => [] } });
  const r = await resolveApiPrincipal(reqWith({ bearer: "sc-x" }), { MASTER_API_KEY: "master" } as any, stores);
  expect(r).toEqual({ userId: "usr_7" });
});

it("resolveApiPrincipal: ownerless key -> null (rejected)", async () => {
  const r = await resolveApiPrincipal(reqWith({ bearer: "sc-x" }), { MASTER_API_KEY: "master" } as any, fakeStores());
  expect(r).toBeNull();
});

it("resolveApiPrincipal: cookie session also accepted (browser playground)", async () => {
  const stores = fakeStores({ sessions: { resolve: async () => ({ user_id: "usr_3" }), touch: async () => {} } });
  const r = await resolveApiPrincipal(reqWith({ cookie: "wagmi_session=tok" }), { MASTER_API_KEY: "master" } as any, stores);
  expect(r).toEqual({ userId: "usr_3" });
});

it("resolveApiPrincipal: dev-open when MASTER_API_KEY unset", async () => {
  const r = await resolveApiPrincipal(reqWith(), {} as any, fakeStores());
  expect(r).toEqual({ userId: DEV_USER_ID });
});
