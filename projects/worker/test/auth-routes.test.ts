import { it, expect } from "vitest";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, normalizeEmail, isValidEmail } from "../src/auth-routes";
import { sha256Hex } from "../src/auth";
import { serializeSessionCookie, SESSION_COOKIE } from "../src/session";

function svc(over: any = {}) {
  const sent: any[] = [];
  const created: any[] = [];
  const base = {
    users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) },
    sessions: { create: async (u: string, h: string) => { created.push({ u, h }); }, resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, delete: async () => {} },
    loginTokens: { create: async () => {}, consume: async () => ({ email: "a@b.co" }) },
    keys: { getKeyOwner: async () => null, addKey: async () => {}, listByUser: async () => [] },
    rateLimiter: { limit: async () => true },
    email: { sendMagicLink: async (e: string, l: string) => { sent.push({ e, l }); } },
  };
  const s = { ...base, ...over };
  (s as any)._sent = sent; (s as any)._created = created;
  return s as any;
}
const cfg = { token: () => "TOK", verifyBase: "https://wagmi.photos", now: () => 0 };
const loginReq = (email: any) => new Request("https://x/v1/auth/login", { method: "POST", body: JSON.stringify({ email }) });

it("normalizeEmail lowercases + trims; isValidEmail basic check", () => {
  expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
  expect(isValidEmail("a@b.co")).toBe(true);
  expect(isValidEmail("nope")).toBe(false);
});

it("login: 200 generic, sends link with token to normalized email", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("A@B.CO"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(res.status).toBe(200);
  expect(s._sent[0].e).toBe("a@b.co");
  expect(s._sent[0].l).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
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
});

it("login: dev mode returns the link in the body", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("a@b.co"), {} as any, s, cfg); // no RESEND_API_KEY
  const j: any = await res.json();
  expect(j.dev_link).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
});

it("verify: valid token sets cookie + 302 to playground", async () => {
  const s = svc();
  const res = await handleVerify(new URL("https://x/v1/auth/verify?token=TOK"), new Request("https://x/v1/auth/verify?token=TOK"), {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://wagmi.photos/#/playground");
  expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=TOK`);
  expect(s._created[0].h).toBe(await sha256Hex("TOK"));
});

it("verify: consumed/expired token -> 302 to login with error", async () => {
  const s = svc({ loginTokens: { create: async () => {}, consume: async () => null } });
  const res = await handleVerify(new URL("https://x/v1/auth/verify?token=BAD"), new Request("https://x/v1/auth/verify?token=BAD"), {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("#/login?error=");
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
