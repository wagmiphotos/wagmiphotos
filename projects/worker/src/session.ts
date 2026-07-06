export const SESSION_COOKIE = "wagmi_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_TTL_SECONDS}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

import type { Env, SessionStore, KeyStore } from "./types";
import { sha256Hex, constantTimeEqual, bearer } from "./auth";

export const MASTER_USER_ID = "usr_master";
export const DEV_USER_ID = "usr_dev";

export async function resolveSession(request: Request, _env: Env, sessions: SessionStore): Promise<{ userId: string } | null> {
  const raw = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const row = await sessions.resolve(hash);
  if (!row) return null;
  await sessions.touch(hash);
  return { userId: row.user_id };
}

export async function resolveApiPrincipal(
  request: Request, env: Env, stores: { sessions: SessionStore; keys: KeyStore }
): Promise<{ userId: string } | null> {
  const token = bearer(request);
  if (token) {
    if (env.MASTER_API_KEY && constantTimeEqual(await sha256Hex(token), await sha256Hex(env.MASTER_API_KEY))) {
      return { userId: MASTER_USER_ID };
    }
    const owner = await stores.keys.getKeyOwner(await sha256Hex(token));
    if (owner) return { userId: owner };
    // a presented-but-unowned key is an explicit failure; fall through to cookie/dev
  }
  const session = await resolveSession(request, env, stores.sessions);
  if (session) return session;
  if (!env.MASTER_API_KEY) return { userId: DEV_USER_ID }; // dev-open API lane
  return null;
}
