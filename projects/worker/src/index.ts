import type { Env, Services, RateLimiter } from "./types";
import { makeD1Stores } from "./d1";
import { makeVectorize } from "./vectorize";
import { bgeTextEmbed } from "./embed";
import { handleGenerate, handleKeygen, type GenBody } from "./handler";
import { handleLibrarySearch, handleLibraryDownload } from "./library";
import { rewritePublicUrls } from "./rewrite";
import { numEnv } from "./config";
import { FLOOR_SIM_MAX, FLOOR_SIM_MIN } from "./floor";
import { makeEmailSender } from "./email";
import { resolveApiPrincipal, resolveSession } from "./session";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, handleListKeys, handleDeleteKey } from "./auth-routes";

function buildServices(env: Env): Services {
  const { assets, queries, keys, users, sessions, loginTokens } = makeD1Stores(env.DB);
  const rateLimiter: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER.limit({ key });
      return success;
    },
  };
  return {
    embedder: { textEmbed: (p) => bgeTextEmbed(p, env) },
    vectorize: makeVectorize([env.VECTORIZE_0, env.VECTORIZE_1, env.VECTORIZE_2]),
    assets, queries, keys, rateLimiter,
    users, sessions, loginTokens, email: makeEmailSender(env),
  };
}

function genKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `sc-${b64}`;
}

// GitHub star count for the header badge. Cached at the edge ~10 min so we never
// hit GitHub's unauthenticated rate limit per visitor. Always 200s with {stars}
// (null when unavailable) so the frontend can degrade gracefully.
async function handleStars(env: Env): Promise<Response> {
  const repo = env.GITHUB_REPO || "wagmiphotos/wagmiphotos";
  const cacheKey = new Request(`https://wagmiphotos.internal/meta/stars/${repo}`);
  try {
    const cache = (globalThis as any).caches?.default;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const gh = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { "User-Agent": "wagmiphotos", Accept: "application/vnd.github+json" },
    });
    let stars: number | null = null;
    if (gh.ok) {
      const data: any = await gh.json();
      if (typeof data?.stargazers_count === "number") stars = data.stargazers_count;
    }
    const res = Response.json({ stars }, { headers: { "Cache-Control": "public, max-age=600" } });
    if (cache && stars != null) await cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    console.error("stars fetch failed", e);
    return Response.json({ stars: null });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const verifyBase = env.PUBLIC_SITE_URL || "https://wagmi.photos";
      const authCfg = { verifyBase };
      const services = buildServices(env);
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return new Response("Not found", { status: 404 });
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/v1/meta/stars") {
        if (request.method !== "GET") return new Response("Not found", { status: 404 });
        return await handleStars(env);
      }

      if (url.pathname === "/v1/auth/login" && request.method === "POST")
        return await handleLoginRequest(request, env, services, authCfg);
      if (url.pathname === "/v1/auth/verify" && request.method === "GET")
        return await handleVerify(url, request, env, services, authCfg);
      if (url.pathname === "/v1/me" && request.method === "GET")
        return await handleMe(request, env, services);
      if (url.pathname === "/v1/auth/logout" && request.method === "POST")
        return await handleLogout(request, env, services);
      if (url.pathname === "/v1/keys" && request.method === "GET")
        return await handleListKeys(request, env, services);
      const keyDel = url.pathname.match(/^\/v1\/keys\/([^/]+)$/);
      if (keyDel && request.method === "DELETE") {
        let id: string;
        try { id = decodeURIComponent(keyDel[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleDeleteKey(id, request, env, services);
      }

      const libraryCfg = { floorSimMin: numEnv(env.FLOOR_SIM_MIN, FLOOR_SIM_MIN), assetBaseUrl: env.ASSET_BASE_URL };

      if (url.pathname === "/v1/library" && request.method === "GET") {
        if (!(await resolveApiPrincipal(request, env, services))) return Response.json({ error: "login required" }, { status: 401 });
        return await handleLibrarySearch(url, services, libraryCfg);
      }

      const dl = url.pathname.match(/^\/v1\/library\/([^/]+)\/download$/);
      if (dl && request.method === "GET") {
        if (!(await resolveApiPrincipal(request, env, services))) return Response.json({ error: "login required" }, { status: 401 });
        let id: string;
        try {
          id = decodeURIComponent(dl[1]);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        return await handleLibraryDownload(id, services, libraryCfg, (u) => fetch(u));
      }

      if (url.pathname === "/v1/keys/generate" && request.method === "POST") {
        const principal = await resolveSession(request, env, services.sessions);
        if (!principal) return Response.json({ error: "login required" }, { status: 401 });
        return await handleKeygen(request, services, genKey, principal.userId);
      }

      if (url.pathname === "/v1/images/generations" && request.method === "POST") {
        const principal = await resolveApiPrincipal(request, env, services);
        if (!principal) return Response.json({ error: "Invalid API Key" }, { status: 401 });
        // Throttle the expensive path (embed + Vectorize) per authenticated
        // principal, namespaced so it doesn't share a bucket with keygen.
        if (!(await services.rateLimiter.limit(`gen:${principal.userId}`))) {
          return Response.json({ error: "Too many requests" }, { status: 429 });
        }
        let body: GenBody;
        try { body = (await request.json()) as GenBody; }
        catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "body must be a JSON object" }, { status: 400 });
        }
        const cfg = {
          floorSimMax: numEnv(env.FLOOR_SIM_MAX, FLOOR_SIM_MAX),
          floorSimMin: numEnv(env.FLOOR_SIM_MIN, FLOOR_SIM_MIN),
          imagePrice: numEnv(env.IMAGE_PRICE_USD, 0.04),
          now: () => Math.floor(Date.now() / 1000),
          assetBaseUrl: env.ASSET_BASE_URL,
        };
        return await handleGenerate(body, services, cfg);
      }

      if (url.pathname.startsWith("/v1/")) {
        return new Response("Not found", { status: 404 });
      }
      return await rewritePublicUrls(await env.ASSETS.fetch(request), env);
    } catch (err) {
      // Full detail to the log only; the client gets a generic body.
      console.error(err);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
};
