import { it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../src/crypto";

const KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const OTHER_KEK = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

it("roundtrips a secret", async () => {
  const ct = await encryptSecret("sk-test-1234567890", KEK);
  expect(await decryptSecret(ct, KEK)).toBe("sk-test-1234567890");
});

it("produces a fresh IV per encryption (no deterministic ciphertext)", async () => {
  const a = await encryptSecret("same-secret", KEK);
  const b = await encryptSecret("same-secret", KEK);
  expect(a).not.toBe(b);
});

it("rejects tampered ciphertext", async () => {
  const ct = await encryptSecret("sk-test", KEK);
  const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  const tampered = btoa(String.fromCharCode(...bytes));
  await expect(decryptSecret(tampered, KEK)).rejects.toThrow();
});

it("rejects the wrong KEK", async () => {
  const ct = await encryptSecret("sk-test", KEK);
  await expect(decryptSecret(ct, OTHER_KEK)).rejects.toThrow();
});

it("rejects a KEK that is not 32 bytes", async () => {
  await expect(encryptSecret("sk-test", btoa("short"))).rejects.toThrow(/32 bytes/);
});
