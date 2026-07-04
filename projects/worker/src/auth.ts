import type { Env, KeyStore } from "./types";

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Length-independent constant-time comparison. Callers compare fixed-length
// SHA-256 digests so the length check never leaks anything about the secret.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  // Compare fixed-length digests in constant time so the master key isn't
  // recoverable by timing the string comparison. Reuse the hash for verifyKey.
  const tokenHash = await sha256Hex(token);
  if (constantTimeEqual(tokenHash, await sha256Hex(env.MASTER_API_KEY))) return true;
  return keys.verifyKey(tokenHash);
}
