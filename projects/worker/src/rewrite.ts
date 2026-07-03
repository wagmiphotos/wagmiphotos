import type { Env } from "./types";

export const DEFAULT_SITE_URL = "https://wagmi.photos";
export const DEFAULT_API_BASE_URL = "https://api.wagmi.photos/v1";

/**
 * Swap the canonical public URLs baked into the SPA for env-configured ones,
 * so dev/staging deployments render their own site and API base URLs.
 * HTML only; anything else streams through untouched.
 */
export async function rewritePublicUrls(res: Response, env: Env): Promise<Response> {
  if (!res.body) return res; // null-body responses (204/205/304) have nothing to rewrite

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return res;

  // API base first — fixed order keeps the substitution deterministic.
  const pairs: [string, string][] = [];
  if (env.PUBLIC_API_BASE_URL && env.PUBLIC_API_BASE_URL !== DEFAULT_API_BASE_URL) {
    pairs.push([DEFAULT_API_BASE_URL, env.PUBLIC_API_BASE_URL]);
  }
  if (env.PUBLIC_SITE_URL && env.PUBLIC_SITE_URL !== DEFAULT_SITE_URL) {
    pairs.push([DEFAULT_SITE_URL, env.PUBLIC_SITE_URL]);
  }
  if (pairs.length === 0) return res;

  let text = await res.text();
  for (const [from, to] of pairs) text = text.replaceAll(from, to);
  const headers = new Headers(res.headers);
  headers.delete("content-length"); // length changed; let the runtime recompute
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}
