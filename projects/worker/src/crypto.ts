// Reversible at-rest encryption for user-supplied provider keys — the ONE
// secret we must replay to a third party, so hashing (auth.ts) can't work.
// AES-256-GCM under the BYOK_KEK worker secret; stored = base64(iv || ct).
const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));

async function importKek(kekB64: string): Promise<CryptoKey> {
  const raw = b64decode(kekB64);
  if (raw.length !== 32) throw new Error("BYOK_KEK must be 32 bytes of base64");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, kekB64: string): Promise<string> {
  const key = await importKek(kekB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64encode(out);
}

export async function decryptSecret(stored: string, kekB64: string): Promise<string> {
  const key = await importKek(kekB64);
  const buf = b64decode(stored);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}
