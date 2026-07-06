import { it, expect } from "vitest";
import { randomToken, parseCookies, serializeSessionCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE } from "../src/session";

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
