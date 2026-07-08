// OpenAI Moderations (free endpoint) — same guardrail the backfill runs
// (wagmiphotos.common.moderation). Throws on transport/HTTP errors so the
// caller can fail closed: no moderation verdict, no generation.
export const MODERATIONS_URL = "https://api.openai.com/v1/moderations";

export async function moderationFlagged(
  text: string, apiKey: string, fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const res = await fetchFn(MODERATIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "omni-moderation-latest" }),
  });
  if (!res.ok) throw new Error(`moderation ${res.status}`);
  const data: any = await res.json();
  const r = data?.results?.[0];
  if (!r?.flagged) return null;
  for (const [name, hit] of Object.entries(r.categories ?? {})) if (hit) return name;
  return "flagged";
}
