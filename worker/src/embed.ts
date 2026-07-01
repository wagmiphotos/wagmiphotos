import type { Env } from "./types";

function flatten(data: any): number[] {
  if (data && typeof data === "object" && "embedding" in data) data = data.embedding;
  if (Array.isArray(data) && Array.isArray(data[0])) data = data[0];
  if (!Array.isArray(data) || typeof data[0] !== "number") {
    throw new Error(`Unexpected embedding response: ${JSON.stringify(data)}`);
  }
  return data as number[];
}

export async function clipTextEmbed(prompt: string, env: Env): Promise<number[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.CLIP_EMBED_TOKEN) headers["Authorization"] = `Bearer ${env.CLIP_EMBED_TOKEN}`;
  const res = await fetch(env.CLIP_TEXT_EMBED_URL, { method: "POST", headers, body: JSON.stringify({ inputs: prompt }) });
  if (res.status !== 200) throw new Error(`CLIP text embed failed (${res.status}): ${await res.text()}`);
  return flatten(await res.json());
}
