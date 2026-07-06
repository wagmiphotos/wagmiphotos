import type { Env, Services } from "./types";
import { sha256Hex } from "./auth";
import {
  randomToken, resolveSession, serializeSessionCookie, clearSessionCookie,
  isSecureRequest, parseCookies, SESSION_COOKIE,
} from "./session";
import { emailIsDevMode } from "./email";

export interface AuthCfg { token?: () => string; verifyBase: string; now?: () => number; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(raw: string): string { return raw.trim().toLowerCase(); }
export function isValidEmail(email: string): boolean { return email.length <= 254 && EMAIL_RE.test(email); }

function clientIp(request: Request): string { return request.headers.get("CF-Connecting-IP") ?? "unknown"; }
const genGeneric = () => Response.json({ status: "sent" });

export async function handleLoginRequest(request: Request, env: Env, s: Services, cfg: AuthCfg): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isValidEmail(email)) return Response.json({ error: "invalid email" }, { status: 400 });

  // Rate-limit by IP and by email; on limit, return the generic 200 without sending.
  const okIp = await s.rateLimiter.limit(`login:ip:${clientIp(request)}`);
  const okEmail = await s.rateLimiter.limit(`login:email:${email}`);
  if (!okIp || !okEmail) return genGeneric();

  const token = (cfg.token ?? randomToken)();
  await s.loginTokens.create(await sha256Hex(token), email);
  const link = `${cfg.verifyBase}/v1/auth/verify?token=${token}`;
  try { await s.email.sendMagicLink(email, link); } catch (e) { console.error("sendMagicLink failed", e); }

  // In dev (no email provider) return the link so local testing works.
  if (emailIsDevMode(env)) return Response.json({ status: "sent", dev_link: link });
  return genGeneric();
}

export async function handleVerify(url: URL, request: Request, env: Env, s: Services, cfg: AuthCfg): Promise<Response> {
  const loginFail = Response.redirect(`${cfg.verifyBase}/#/login?error=invalid_or_expired`, 302);
  const raw = url.searchParams.get("token");
  if (!raw) return loginFail;
  const consumed = await s.loginTokens.consume(await sha256Hex(raw));
  if (!consumed) return loginFail;

  const id = `usr_${randomToken(12)}`;
  const user = await s.users.upsertByEmail(id, consumed.email);
  const sessionToken = (cfg.token ?? randomToken)();
  await s.sessions.create(user.id, await sha256Hex(sessionToken));

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${cfg.verifyBase}/#/playground`,
      "Set-Cookie": serializeSessionCookie(sessionToken, isSecureRequest(request)),
    },
  });
}

export async function handleMe(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  const user = await s.users.getById(principal.userId);
  if (!user) return Response.json({ error: "not authenticated" }, { status: 401 });
  return Response.json({ user: { id: user.id, email: user.email } });
}

export async function handleLogout(request: Request, env: Env, s: Services): Promise<Response> {
  const raw = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (raw) await s.sessions.delete(await sha256Hex(raw));
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie(isSecureRequest(request)) },
  });
}

export async function handleListKeys(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  return Response.json({ keys: await s.keys.listByUser(principal.userId) });
}
