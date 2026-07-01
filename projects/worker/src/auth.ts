import type { Env, KeyStore } from "./types";

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

export async function checkAuth(request: Request, env: Env, keys: KeyStore): Promise<boolean> {
  if (!env.MASTER_API_KEY) {
    console.warn("checkAuth: MASTER_API_KEY unset — auth is OPEN (dev mode)");
    return true; // open in dev
  }
  const token = bearer(request);
  if (!token) return false;
  if (token === env.MASTER_API_KEY) return true;
  return keys.verifyKey(await sha256Hex(token));
}
