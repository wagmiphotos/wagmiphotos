// Parse a string env var to a number. An absent, blank, or unparseable value
// falls back to the default (so a genuine "0" is honored and a typo like "abc"
// never becomes a NaN used downstream).
export function numEnv(raw: string | undefined, def: number): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`numEnv: ignoring non-numeric value ${JSON.stringify(raw)}, using default ${def}`);
    return def;
  }
  return n;
}
