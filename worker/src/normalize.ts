export function normalizePrompt(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).join(" ");
}
