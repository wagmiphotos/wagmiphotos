import type { Env, Services } from "./types";
import { sha256Hex } from "./auth";
import {
  randomToken, resolveSession, serializeSessionCookie, clearSessionCookie,
  isSecureRequest, parseCookies, SESSION_COOKIE,
  serializeLoginNonceCookie, clearLoginNonceCookie, LOGIN_NONCE_COOKIE,
} from "./session";
import { emailIsDevMode } from "./email";
import { planView } from "./entitlement";
import { byokView } from "./byok-routes";

export interface AuthCfg { token?: () => string; nonce?: () => string; verifyBase: string; now?: () => number; }

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

  // Opportunistic GC: both tables are indexed on expires_at; failures are
  // logged, never fatal to the login itself.
  try { await s.loginTokens.purgeExpired(); } catch (e) { console.error("login_tokens purge failed", e); }
  try { await s.sessions.purgeExpired(); } catch (e) { console.error("sessions purge failed", e); }

  const token = (cfg.token ?? randomToken)();
  const nonce = (cfg.nonce ?? randomToken)();
  await s.loginTokens.create(await sha256Hex(token), email, await sha256Hex(nonce));
  const link = `${cfg.verifyBase}/v1/auth/verify?token=${token}`;
  try { await s.email.sendMagicLink(email, link); } catch (e) { console.error("sendMagicLink failed", e); }

  // In dev (no email provider) return the link so local testing works.
  const cookie = serializeLoginNonceCookie(nonce, isSecureRequest(request));
  const resBody = emailIsDevMode(env) ? { status: "sent", dev_link: link } : { status: "sent" };
  return Response.json(resBody, { headers: { "Set-Cookie": cookie } });
}

export async function handleVerify(url: URL, request: Request, env: Env, s: Services, cfg: AuthCfg): Promise<Response> {
  const loginFail = Response.redirect(`${cfg.verifyBase}/#/login?error=invalid_or_expired`, 302);
  const rawToken = url.searchParams.get("token");
  const nonce = parseCookies(request.headers.get("Cookie"))[LOGIN_NONCE_COOKIE];
  if (!rawToken || !nonce) return loginFail;
  const consumed = await s.loginTokens.consume(await sha256Hex(rawToken), await sha256Hex(nonce));
  if (!consumed) return loginFail;

  const id = `usr_${randomToken(12)}`;
  const user = await s.users.upsertByEmail(id, consumed.email);
  const sessionToken = (cfg.token ?? randomToken)();
  await s.sessions.create(user.id, await sha256Hex(sessionToken));

  const secure = isSecureRequest(request);
  const headers = new Headers({ Location: `${cfg.verifyBase}/#/playground` });
  headers.append("Set-Cookie", serializeSessionCookie(sessionToken, secure));
  headers.append("Set-Cookie", clearLoginNonceCookie(secure));
  return new Response(null, { status: 302, headers });
}

// Current Acceptable-Use Policy version. Bump when docs/legal/acceptable-use-policy.md
// materially changes — users whose accepted version is older must re-accept.
export const TOS_VERSION = "2026-07-08";

export async function handleMe(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  const user = await s.users.getById(principal.userId);
  if (!user) return Response.json({ error: "not authenticated" }, { status: 401 });
  return Response.json({
    user: { id: user.id, email: user.email },
    plan: planView(user),
    tos: {
      current_version: TOS_VERSION,
      accepted: user.tos_version === TOS_VERSION,
      accepted_version: user.tos_version,
    },
    byok: await byokView(s, principal.userId, Math.floor(Date.now() / 1000)),
  });
}

export async function handleAcceptTos(request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  // Cloudflare sets CF-Connecting-IP to the real client IP at the edge.
  const ip = request.headers.get("CF-Connecting-IP");
  const userAgent = request.headers.get("User-Agent");
  await s.users.acceptTos(principal.userId, TOS_VERSION, ip, userAgent);
  return Response.json({ status: "ok", tos_version: TOS_VERSION });
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

export async function handleDeleteKey(id: string, request: Request, env: Env, s: Services): Promise<Response> {
  const principal = await resolveSession(request, env, s.sessions);
  if (!principal) return Response.json({ error: "not authenticated" }, { status: 401 });
  // Scoped to the caller's own keys inside deleteKey; a no-match is a silent no-op
  // (idempotent, and no signal about whether the id belonged to another user).
  await s.keys.deleteKey(principal.userId, id);
  return Response.json({ status: "ok" });
}
