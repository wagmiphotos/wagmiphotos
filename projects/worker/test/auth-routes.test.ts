import { it, expect } from "vitest";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, handleAcceptTos, TOS_VERSION, normalizeEmail, isValidEmail } from "../src/auth-routes";
import { sha256Hex } from "../src/auth";
import { serializeSessionCookie, SESSION_COOKIE, LOGIN_NONCE_COOKIE } from "../src/session";

function svc(over: any = {}) {
  const sent: any[] = [];
  const created: any[] = [];
  const consumeCalls: any[] = [];
  const purged: string[] = [];
  const byokRows = new Map<string, any>();
  const base = {
    users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) },
    sessions: { create: async (u: string, h: string) => { created.push({ u, h }); }, resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, delete: async () => {}, purgeExpired: async () => { purged.push("sessions"); } },
    loginTokens: {
      create: async () => {},
      // Models the atomic nonce guard: only the expected nonceHash (sha256("NON")) redeems the token.
      consume: async (tokenHash: string, nonceHash: string) => {
        consumeCalls.push({ tokenHash, nonceHash });
        return nonceHash === (await sha256Hex("NON")) ? { email: "a@b.co" } : null;
      },
      purgeExpired: async () => { purged.push("loginTokens"); },
    },
    keys: { getKeyOwner: async () => null, addKey: async () => {}, listByUser: async () => [] },
    rateLimiter: { limit: async () => true },
    email: { sendMagicLink: async (e: string, l: string) => { sent.push({ e, l }); } },
    byok: {
      get: async (u: string) => byokRows.get(u) ?? null,
      put: async (i: any) => { byokRows.set(i.userId, { user_id: i.userId, provider: i.provider, key_ciphertext: i.keyCiphertext, key_last4: i.keyLast4, enabled: i.enabled ? 1 : 0, monthly_cap: i.monthlyCap, last_error: null, created_at: "x", updated_at: "x" }); },
      patch: async (u: string, f: any) => { const r = byokRows.get(u); if (!r) return; if (f.enabled != null) r.enabled = f.enabled ? 1 : 0; if (f.monthlyCap != null) r.monthly_cap = f.monthlyCap; },
      delete: async (u: string) => { byokRows.delete(u); },
      disable: async (u: string, err: string) => { const r = byokRows.get(u); if (r) { r.enabled = 0; r.last_error = err; } },
      getUsage: async () => ({ count: 0, est_spend_usd: 0 }),
      reserve: async () => true,
      refund: async () => {},
      addSpend: async () => {},
    },
  };
  const s = { ...base, ...over };
  (s as any)._sent = sent; (s as any)._created = created; (s as any)._consumeCalls = consumeCalls; (s as any)._purged = purged;
  (s as any)._byokRows = byokRows;
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

it("login: dev mode (DEV_MODE set, no RESEND_API_KEY) returns the link in the body", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("a@b.co"), { DEV_MODE: "true" } as any, s, cfg);
  const j: any = await res.json();
  expect(j.dev_link).toBe("https://wagmi.photos/v1/auth/verify?token=TOK");
});

it("login: RESEND_API_KEY unset and NOT dev mode -> generic 200 without dev_link", async () => {
  const s = svc();
  const res = await handleLoginRequest(loginReq("a@b.co"), {} as any, s, cfg); // prod misconfig: no provider
  expect(res.status).toBe(200);
  const j: any = await res.json();
  expect(j).toEqual({ status: "sent" }); // no magic link leaked to the caller
});

it("login: opportunistically purges expired login tokens and sessions", async () => {
  const s = svc();
  await handleLoginRequest(loginReq("a@b.co"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(s._purged).toContain("loginTokens");
  expect(s._purged).toContain("sessions");
});

it("login: rate-limited requests do not purge (returns generic early)", async () => {
  const s = svc({ rateLimiter: { limit: async () => false } });
  await handleLoginRequest(loginReq("a@b.co"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(s._purged).toEqual([]);
});

it("login: purge failure is logged, not fatal — login still succeeds", async () => {
  const s = svc({
    sessions: { create: async () => {}, resolve: async () => null, touch: async () => {}, delete: async () => {}, purgeExpired: async () => { throw new Error("d1 down"); } },
    loginTokens: { create: async () => {}, consume: async () => null, purgeExpired: async () => { throw new Error("d1 down"); } },
  });
  const res = await handleLoginRequest(loginReq("a@b.co"), { RESEND_API_KEY: "re" } as any, s, cfg);
  expect(res.status).toBe(200);
  expect(s._sent.length).toBe(1); // link still sent
});

it("verify: valid token + matching nonce cookie sets session cookie, clears nonce cookie, 302 to library", async () => {
  const s = svc();
  const req = verifyReq("TOK", "NON");
  const res = await handleVerify(new URL(req.url), req, {} as any, s, cfg);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://wagmi.photos/#/library");
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

it("me: reports ToS acceptance status against the current version", async () => {
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=tok` } });
  const notYet = svc({ users: { getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null }) } });
  const b1 = await (await handleMe(req, {} as any, notYet)).json() as any;
  expect(b1.tos.current_version).toBe(TOS_VERSION);
  expect(b1.tos.accepted).toBe(false);

  const done = svc({ users: { getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: TOS_VERSION, tos_accepted_at: "2026-07-08" }) } });
  const b2 = await (await handleMe(req, {} as any, done)).json() as any;
  expect(b2.tos.accepted).toBe(true);
});

it("accept-tos: records version + IP + user-agent for the session user; 401 anon", async () => {
  let recorded: any = null;
  const s = svc({ users: { getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null }), acceptTos: async (uid: string, v: string, ip: string | null, ua: string | null) => { recorded = { uid, v, ip, ua }; } } });
  const req = new Request("https://x/v1/auth/accept-tos", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=tok`, "CF-Connecting-IP": "203.0.113.7", "User-Agent": "TestBrowser/1.0" } });
  const ok = await handleAcceptTos(req, {} as any, s);
  expect(ok.status).toBe(200);
  expect(recorded).toEqual({ uid: "usr_1", v: TOS_VERSION, ip: "203.0.113.7", ua: "TestBrowser/1.0" });

  const anon = svc({ sessions: { resolve: async () => null, touch: async () => {}, create: async () => {}, delete: async () => {}, purgeExpired: async () => {} } });
  const res = await handleAcceptTos(new Request("https://x/v1/auth/accept-tos", { method: "POST" }), {} as any, anon);
  expect(res.status).toBe(401);
});

it("logout: clears cookie + deletes session", async () => {
  let deleted = "";
  const s = svc({ sessions: { resolve: async () => ({ user_id: "usr_1" }), touch: async () => {}, create: async () => {}, delete: async (h: string) => { deleted = h; } } });
  const res = await handleLogout(new Request("https://x/v1/auth/logout", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=tok` } }), {} as any, s);
  expect(res.status).toBe(200);
  expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(deleted).toBe(await sha256Hex("tok"));
});

it("me includes the plan projection", async () => {
  const paid = svc({ users: { upsertByEmail: async (id: string, email: string) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: "active", plan_current_period_end: "2027-07-08T00:00:00.000Z" }), acceptTos: async () => {} } });
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=s` } });
  const res = await handleMe(req, {} as any, paid);
  const j: any = await res.json();
  expect(j.plan).toEqual({ active: true, status: "active", current_period_end: "2027-07-08T00:00:00.000Z" });
});

it("me: byok is null without a key", async () => {
  const s = svc();
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=tok` } });
  const res = await handleMe(req, {} as any, s);
  const j: any = await res.json();
  expect(j.byok).toBeNull();
});

it("me includes the byok block when a key exists", async () => {
  const s = svc();
  await s.byok.put({ userId: "usr_1", provider: "openai", keyCiphertext: "ct", keyLast4: "2345", monthlyCap: 50, enabled: true });
  const req = new Request("https://x/v1/me", { headers: { Cookie: `${SESSION_COOKIE}=tok` } });
  const res = await handleMe(req, {} as any, s);
  const body: any = await res.json();
  expect(body.byok).toMatchObject({ provider: "openai", key_last4: "2345" });
});
