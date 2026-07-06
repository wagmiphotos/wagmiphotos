import type { Env } from "./types";

export const BGE_MODEL = "@cf/baai/bge-base-en-v1.5";

function l2normalize(vec: number[]): number[] {
  let s = 0;
  for (const x of vec) s += x * x;
  const n = Math.sqrt(s) || 1;
  return vec.map((x) => x / n);
}

// Text-to-text prompt embedding via Workers AI. Raw text, NO instruction prefix
// (symmetric similarity); output is L2-normalized to guarantee the shared contract.
export async function bgeTextEmbed(prompt: string, env: Env): Promise<number[]> {
  const out: any = await env.AI.run(BGE_MODEL, { text: prompt });
  const vec = out?.data?.[0];
  if (!Array.isArray(vec) || typeof vec[0] !== "number") {
    throw new Error(`Unexpected embedding response: ${JSON.stringify(out)}`);
  }
  return l2normalize(vec as number[]);
}
