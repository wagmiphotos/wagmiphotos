import type { Env, Services, RateLimiter } from "./types";
import { makeD1Stores } from "./d1";
import { makeVectorize } from "./vectorize";
import { bgeTextEmbed } from "./embed";
import { handleGenerate, handleKeygen, type GenBody } from "./handler";
import { handleHome } from "./home";
import { handleLibrarySearch, handleLibraryDownload, handleLikeAsset, handleUnlikeAsset } from "./library";
import { rewritePublicUrls } from "./rewrite";
import { numEnv } from "./config";
import { FLOOR_SIM_MAX, FLOOR_SIM_MIN, LIBRARY_FLOOR_SIM } from "./floor";
import { makeEmailSender } from "./email";
import { makeStripe } from "./stripe";
import { resolveApiPrincipal, resolveSession, type Principal } from "./session";
import { handleLoginRequest, handleVerify, handleMe, handleLogout, handleAcceptTos, handleListKeys, handleDeleteKey } from "./auth-routes";
import { handleCheckout, handlePortal, handleStripeWebhook } from "./stripe-routes";
import { isPaid } from "./entitlement";
import { handlePutByok, handlePatchByok, handleDeleteByok } from "./byok-routes";
import {
  handleCreateCollection, handleListCollections, handlePatchCollection,
  handleListCollectionImages, handleDeleteCollectionImage, handleDeleteCollection,
  handleBrowseCollections, type CollModCfg,
} from "./collections-routes";
import { handleCreateGeneration, handleGetGeneration, handleListCollectionGenerations } from "./generations-routes";
import { sweepGenerations, type GenJobsCfg } from "./generation-jobs";

function buildServices(env: Env): Services {
  const { assets, queries, keys, users, sessions, loginTokens, byok, collections, generations } = makeD1Stores(env.DB);
  const rateLimiter: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER.limit({ key });
      return success;
    },
  };
  const rateLimiterPaid: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER_PAID) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER_PAID.limit({ key });
      return success;
    },
  };
  const rateLimiterSearch: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER_SEARCH) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER_SEARCH.limit({ key });
      return success;
    },
  };
  const rateLimiterSearchUser: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER_SEARCH_USER) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER_SEARCH_USER.limit({ key });
      return success;
    },
  };
  return {
    embedder: { textEmbed: (p) => bgeTextEmbed(p, env) },
    vectorize: makeVectorize([env.VECTORIZE_0, env.VECTORIZE_1, env.VECTORIZE_2], env.VECTORIZE_COLL),
    assets, queries, keys, rateLimiter, rateLimiterPaid, rateLimiterSearch, rateLimiterSearchUser,
    users, sessions, loginTokens, email: makeEmailSender(env), stripe: makeStripe(env), byok, collections, generations,
  };
}

function genKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `sc-${b64}`;
}

// Public library read access: anonymous is allowed but rate-limited per IP;
// authenticated callers get the looser per-user limiter.
async function libraryAccess(
  request: Request, env: Env, services: Services
): Promise<{ principal: Principal | null; ok: boolean }> {
  const principal = await resolveApiPrincipal(request, env, services);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ok = principal
    ? await services.rateLimiterSearchUser.limit(`u:${principal.userId}`)
    : await services.rateLimiterSearch.limit(`ip:${ip}`);
  return { principal, ok };
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

function genJobsCfg(env: Env, waitUntil?: (p: Promise<unknown>) => void): GenJobsCfg {
  return {
    kek: env.BYOK_KEK, moderationKey: env.OPENAI_API_KEY,
    bucket: env.BYOK_ORIGINALS, publicUrlBase: env.BYOK_PUBLIC_URL_BASE,
    now: () => Math.floor(Date.now() / 1000),
    waitUntil,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

      // Landing-page stats. Public + cached a day via the same Cache API
      // idiom as /v1/meta/stars (Workers don't auto-cache handler responses).
      if (url.pathname === "/v1/home") {
        if (request.method !== "GET") return new Response("Not found", { status: 404 });
        const cacheKey = new Request("https://wagmiphotos.internal/v1/home");
        const cache = (globalThis as any).caches?.default;
        if (cache) {
          const hit = await cache.match(cacheKey);
          if (hit) return hit;
        }
        const res = await handleHome(services, { assetBaseUrl: env.ASSET_BASE_URL });
        if (cache && res.ok) await cache.put(cacheKey, res.clone());
        return res;
      }

      if (url.pathname === "/v1/auth/login" && request.method === "POST")
        return await handleLoginRequest(request, env, services, authCfg);
      if (url.pathname === "/v1/auth/verify" && request.method === "GET")
        return await handleVerify(url, request, env, services, authCfg);
      if (url.pathname === "/v1/me" && request.method === "GET")
        return await handleMe(request, env, services);
      if (url.pathname === "/v1/auth/logout" && request.method === "POST")
        return await handleLogout(request, env, services);
      if (url.pathname === "/v1/auth/accept-tos" && request.method === "POST")
        return await handleAcceptTos(request, env, services);
      if (url.pathname === "/v1/keys" && request.method === "GET")
        return await handleListKeys(request, env, services);
      const keyDel = url.pathname.match(/^\/v1\/keys\/([^/]+)$/);
      if (keyDel && request.method === "DELETE") {
        let id: string;
        try { id = decodeURIComponent(keyDel[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleDeleteKey(id, request, env, services);
      }

      if (url.pathname === "/v1/billing/checkout" && request.method === "POST")
        return await handleCheckout(request, env, services);
      if (url.pathname === "/v1/billing/portal" && request.method === "POST")
        return await handlePortal(request, env, services);
      if (url.pathname === "/v1/stripe/webhook" && request.method === "POST")
        return await handleStripeWebhook(request, env, services);

      if (url.pathname === "/v1/byok") {
        if (request.method === "PUT") return await handlePutByok(request, env, services);
        if (request.method === "PATCH") return await handlePatchByok(request, env, services);
        if (request.method === "DELETE") return await handleDeleteByok(request, env, services);
      }

      const libraryCfg = { floorSimMin: numEnv(env.LIBRARY_FLOOR_SIM, LIBRARY_FLOOR_SIM), assetBaseUrl: env.ASSET_BASE_URL };

      const collModCfg: CollModCfg = { kek: env.BYOK_KEK, moderationKey: env.OPENAI_API_KEY };
      if (url.pathname === "/v1/collections") {
        if (request.method === "POST") return await handleCreateCollection(request, env, services, collModCfg);
        if (request.method === "GET") return await handleListCollections(request, env, services);
      }
      if (url.pathname === "/v1/collections/browse" && request.method === "GET") {
        return await handleBrowseCollections(url, request, env, services, libraryCfg);
      }
      const genCreate = url.pathname.match(/^\/v1\/collections\/([^/]+)\/generations$/);
      if (genCreate && request.method === "POST") {
        let id: string;
        try { id = decodeURIComponent(genCreate[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleCreateGeneration(id, request, env, services, genJobsCfg(env, (p) => ctx.waitUntil(p)), env.ASSET_BASE_URL);
      }
      if (genCreate && request.method === "GET") {
        let id: string;
        try { id = decodeURIComponent(genCreate[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleListCollectionGenerations(id, url, request, env, services);
      }
      const genGet = url.pathname.match(/^\/v1\/generations\/([^/]+)$/);
      if (genGet && request.method === "GET") {
        let id: string;
        try { id = decodeURIComponent(genGet[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleGetGeneration(id, request, env, services, genJobsCfg(env, (p) => ctx.waitUntil(p)), env.ASSET_BASE_URL);
      }
      const collImages = url.pathname.match(/^\/v1\/collections\/([^/]+)\/images$/);
      if (collImages && request.method === "GET") {
        let id: string;
        try { id = decodeURIComponent(collImages[1]); } catch { return new Response("Not found", { status: 404 }); }
        return await handleListCollectionImages(id, url, request, env, services, libraryCfg);
      }
      const collImageDel = url.pathname.match(/^\/v1\/collections\/([^/]+)\/images\/([^/]+)$/);
      if (collImageDel && request.method === "DELETE") {
        let cid: string, aid: string;
        try { cid = decodeURIComponent(collImageDel[1]); aid = decodeURIComponent(collImageDel[2]); }
        catch { return new Response("Not found", { status: 404 }); }
        return await handleDeleteCollectionImage(cid, aid, request, env, services);
      }
      const collOne = url.pathname.match(/^\/v1\/collections\/([^/]+)$/);
      if (collOne && (request.method === "PATCH" || request.method === "DELETE")) {
        let id: string;
        try { id = decodeURIComponent(collOne[1]); } catch { return new Response("Not found", { status: 404 }); }
        if (request.method === "PATCH") return await handlePatchCollection(id, request, env, services, collModCfg);
        return await handleDeleteCollection(id, request, env, services);
      }

      if (url.pathname === "/v1/library" && request.method === "GET") {
        const { principal, ok } = await libraryAccess(request, env, services);
        if (!ok) return Response.json({ error: "rate limited" }, { status: 429 });
        return await handleLibrarySearch(url, services, libraryCfg, principal?.userId ?? null);
      }

      const dl = url.pathname.match(/^\/v1\/library\/([^/]+)\/download$/);
      if (dl && request.method === "GET") {
        const { ok } = await libraryAccess(request, env, services);
        if (!ok) return Response.json({ error: "rate limited" }, { status: 429 });
        let id: string;
        try {
          id = decodeURIComponent(dl[1]);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        return await handleLibraryDownload(id, services, libraryCfg, (u) => fetch(u));
      }

      const likeM = url.pathname.match(/^\/v1\/library\/([^/]+)\/like$/);
      if (likeM && (request.method === "POST" || request.method === "DELETE")) {
        const principal = await resolveApiPrincipal(request, env, services);
        if (!principal) return Response.json({ error: "login required" }, { status: 401 });
        let id: string;
        try { id = decodeURIComponent(likeM[1]); } catch { return new Response("Not found", { status: 404 }); }
        return request.method === "POST"
          ? await handleLikeAsset(id, principal.userId, services)
          : await handleUnlikeAsset(id, principal.userId, services);
      }

      if (url.pathname === "/v1/keys/generate" && request.method === "POST") {
        const principal = await resolveSession(request, env, services.sessions);
        if (!principal) return Response.json({ error: "login required" }, { status: 401 });
        const user = await services.users.getById(principal.userId);
        if (!isPaid(user)) return Response.json({ error: "Unlimited plan required", upgrade_url: `${verifyBase}/#/account` }, { status: 402 });
        return await handleKeygen(request, services, genKey, principal.userId);
      }

      if (url.pathname === "/v1/images/generations" && request.method === "POST") {
        const principal = await resolveApiPrincipal(request, env, services);
        if (!principal) return Response.json({ error: "Invalid API Key" }, { status: 401 });
        // The programmatic (bearer-key) API is the paid surface; the session
        // playground stays free. Master/dev bypass and use the higher limiter.
        let paid = principal.via === "master" || principal.via === "dev";
        if (principal.via === "key") {
          const owner = await services.users.getById(principal.userId);
          if (!isPaid(owner)) return Response.json({ error: "Unlimited plan required", upgrade_url: `${verifyBase}/#/account` }, { status: 402 });
          paid = true;
        }
        const limiter = paid ? services.rateLimiterPaid : services.rateLimiter;
        if (!(await limiter.limit(`gen:${principal.userId}`))) {
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
          imagePrice: numEnv(env.IMAGE_PRICE_USD, 0.055),
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

  // Cron backstop for async generation jobs nobody polled to completion:
  // re-drives recoverable ones, fails+refunds abandoned ones.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const services = buildServices(env);
    ctx.waitUntil(sweepGenerations(services, genJobsCfg(env, (p) => ctx.waitUntil(p))));
  },
};
