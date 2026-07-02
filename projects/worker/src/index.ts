import type { Env, Services, RateLimiter } from "./types";
import { makeD1Stores } from "./d1";
import { makeVectorize } from "./vectorize";
import { clipTextEmbed } from "./embed";
import { checkAuth } from "./auth";
import { handleGenerate, handleKeygen, type GenBody } from "./handler";

function buildServices(env: Env): Services {
  const { assets, queries, keys } = makeD1Stores(env.DB);
  const rateLimiter: RateLimiter = {
    async limit(key) {
      if (!env.RATE_LIMITER) return true; // no binding in dev
      const { success } = await env.RATE_LIMITER.limit({ key });
      return success;
    },
  };
  return {
    clip: { textEmbed: (p) => clipTextEmbed(p, env) },
    vectorize: makeVectorize(env.VECTORIZE),
    assets, queries, keys, rateLimiter,
  };
}

function genKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `sc-${b64}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return new Response("Not found", { status: 404 });
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/v1/keys/generate" && request.method === "POST") {
        return await handleKeygen(request, buildServices(env), genKey);
      }

      if (url.pathname === "/v1/images/generations" && request.method === "POST") {
        const services = buildServices(env);
        if (!(await checkAuth(request, env, services.keys))) {
          return Response.json({ error: "Invalid API Key" }, { status: 401 });
        }
        let body: GenBody;
        try { body = (await request.json()) as GenBody; }
        catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "body must be a JSON object" }, { status: 400 });
        }
        const cfg = {
          floorSimMax: env.FLOOR_SIM_MAX ? Number(env.FLOOR_SIM_MAX) : 0.35,
          floorSimMin: env.FLOOR_SIM_MIN ? Number(env.FLOOR_SIM_MIN) : 0.18,
          imagePrice: env.IMAGE_PRICE_USD ? Number(env.IMAGE_PRICE_USD) : 0.04,
          now: () => Math.floor(Date.now() / 1000),
        };
        return await handleGenerate(body, services, cfg);
      }

      if (url.pathname.startsWith("/v1/")) {
        return new Response("Not found", { status: 404 });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return Response.json({ error: "upstream error", detail: String(err) }, { status: 502 });
    }
  },
};
