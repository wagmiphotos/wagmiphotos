import { it, expect } from "vitest";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, normalizeEmail, isValidEmail } from "../src/auth-routes";
import { sha256Hex } from "../src/auth";
import { serializeSessionCookie, SESSION_COOKIE, LOGIN_NONCE_COOKIE } from "../src/session";

function svc(over: any = {}) {
  const sent: any[] = [];
  const created: any[] = [];
  const consumeCalls: any[] = [];
  const base = {
    users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) },
    sessions: { create: async (u: string, h: string) => { created.push({ u, h }); }, resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, delete: async () => {} },
    loginTokens: {
      create: async () => {},
      // Models the atomic nonce guard: only the expected nonceHash (sha256("NON")) redeems the token.
      consume: async (tokenHash: string, nonceHash: string) => {
        consumeCalls.push({ tokenHash, nonceHash });
        return nonceHash === (await sha256Hex("NON")) ? { email: "a@b.co" } : null;
      },
    },
    keys: { getKeyOwner: async () => null, addKey: async () => {}, listByUser: async () => [] },
    rateLimiter: { limit: async () => true },
    email: { sendMagicLink: async (e: string, l: string) => { sent.push({ e, l }); } },
  };
  const s = { ...base, ...over };
  (s as any)._sent = sent; (s as any)._created = created; (s as any)._consumeCalls = consumeCalls;
  return s as any;
}
const cfg = { token: () => "TOK", nonce: () => "NON", verifyBase: "https://wagmi.photos", now: () => 0 };
const loginReq = (email: any) => new Request("https://x/v1/auth/login", { method: "POST", body: JSON.stringify({ email }) });
const verifyReq = (token: string, nonceCookie?: string) =>
  new Request(`https://x/v1/auth/verify?token=${token}`, nonceCookie ? { headers: { Cookie: `${LOGIN_NONCE_COOKIE}=${nonceCookie}` } } : {});

it("normalizeEmail lowercases + trims; isValidEmail basic check", () => {
  expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
  expect(isValidEmail("a@b.co")).toBe(true);
  expect(isValidEmail("nope")).toBe(false);
});

it("login: 200 generic, sends link with token to normalized email, sets login-nonce cookie", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("A@B.CO"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(res.status).toBe(200);
  expect(s._sent[0].e).toBe("a@b.co");
  expect(s._sent[0].l).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
  expect(res.headers.get("Set-Cookie")).toContain(`${LOGIN_NONCE_COOKIE}=`);
});

it("login: invalid email -> 400", async () => {
  const res = await handleLoginRequest(loginReq("nope"), {} as any, svc(), cfg);
  expect(res.status).toBe(400);
});

it("login: rate-limited still returns generic 200 and does not send", async () => {
  const s = svc({ rateLimiter: { limit: async () => false } });
  const res = await handleLoginRequest(loginReq("a@b.co"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(res.status).toBe(200);
  expect(s._sent.length).toBe(0);
  const j: any = await res.json();
  expect(j).toEqual({ status: "sent" }); // leaks no distinguishing field vs. the non-rate-limited generic response
});

it("login: known vs unknown email yields byte-identical response (enumeration-safe)", async () => {
  const known = svc({ users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) } });
  const unknown = svc({ users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => null } });
  const env = { RESEND_API_KEY: "re" } as any; // prod mode: no dev_link
  const resKnown = await handleLoginRequest(loginReq("known@b.co"), env, known, cfg);
  const resUnknown = await handleLoginRequest(loginReq("unknown@b.co"), env, unknown, cfg);
  expect(resKnown.status).toBe(resUnknown.status);
  const jKnown: any = await resKnown.json();
  const jUnknown: any = await resUnknown.json();
  expect(jKnown).toEqual(jUnknown);
});

it("login: dev mode returns the link in the body", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("a@b.co"), {} as any, s, cfg); // no RESEND_API_KEY
  const j: any = await res.json();
  expect(j.dev_link).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
});

it("verify: valid token + matching nonce cookie sets session cookie, clears nonce cookie, 302 to playground", async () => {
  const s = svc();
  const req = verifyReq("TOK", "NON");
  const res = await handleVerify(new URL(req.url), req, {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://wagmi.photos/#/playground");
  const headersAny = res.headers as any;
  const setCookie = typeof headersAny.getSetCookie === "function" ? headersAny.getSetCookie().join(", ") : (res.headers.get("Set-Cookie") ?? "");
  expect(setCookie).toContain(`${SESSION_COOKIE}=TOK`);
  expect(setCookie).toContain(`${LOGIN_NONCE_COOKIE}=`);
  expect(setCookie).toContain("Max-Age=0"); // clears the login-nonce cookie
  expect(s._created[0].h).toBe(await sha256Hex("TOK"));
  expect(s._consumeCalls[0]).toEqual({ tokenHash: await sha256Hex("TOK"), nonceHash: await sha256Hex("NON") });
});

it("verify: consumed/expired token -> 302 to login with error", async () => {
  const s = svc({ loginTokens: { create: async () => {}, consume: async () => null } });
  const req = verifyReq("BAD", "NON");
  const res = await handleVerify(new URL(req.url), req, {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("#/login?error=");
  expect(s._created.length).toBe(0); // no session created on failed verify
});

it("verify: missing nonce cookie -> loginFail, consume never called (token not burned)", async () => {
  const s = svc();
  const req = verifyReq("TOK"); // no Cookie header at all
  const res = await handleVerify(new URL(req.url), req, {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("#/login?error=");
  expect(s._consumeCalls.length).toBe(0);
  expect(s._created.length).toBe(0);
});

it("verify: wrong nonce cookie -> loginFail, consume called but returns null (token not consumed)", async () => {
  const s = svc();
  const req = verifyReq("TOK", "BAD");
  const res = await handleVerify(new URL(req.url), req, {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("#/login?error=");
  expect(s._consumeCalls[0]).toEqual({ tokenHash: await sha256Hex("TOK"), nonceHash: await sha256Hex("BAD") });
  expect(s._created.length).toBe(0);
});

it("me: 200 with user when session resolves, 401 otherwise", async () => {
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=tok` } });
  const ok = await handleMe(req, {} as any, svc());
  expect(ok.status).toBe(200);
  const anon = await handleMe(new Request("https://x/v1/me"), {} as any, svc());
  expect(anon.status).toBe(401);
});

it("logout: clears cookie + deletes session", async () => {
  let deleted = "";
  const s = svc({ sessions: { resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, create: async () => {}, delete: async (h: string) => { deleted = h; } } });
  const res = await handleLogout(new Request("https://x/v1/auth/logout", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=tok` } }), {} as any, s);
  expect(res.status).toBe(200);
  expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(deleted).toBe(await sha256Hex("tok"));
});
