import contract from "../../../contract.json";

// Direct HTTP adapters for the two BYOK providers. Models are pinned in
// contract.json (byok_providers) — the public API has no model parameter.
export interface GeneratedImage { bytes: ArrayBuffer; mime: string; }
export class ProviderAuthError extends Error {}
export interface ImageProvider {
  generate(prompt: string, apiKey: string): Promise<GeneratedImage>;
  validateKey(apiKey: string): Promise<boolean>;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PINNED: Record<string, { model: string; price_per_image_usd: number }> = (contract as any).byok_providers;

const OPENAI_API = "https://api.openai.com/v1";

function makeOpenAiProvider(fetchFn: typeof fetch): ImageProvider {
  return {
    async generate(prompt, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: PINNED.openai.model, prompt, n: 1, size: "1024x1024" }),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai images ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data: any = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 !== "string") throw new Error("openai images: no b64_json in response");
      return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, mime: "image/png" };
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${OPENAI_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return res.ok;
    },
  };
}

// GMI Cloud's async request queue (same API genblaze_gmicloud wraps):
// submit -> poll until a terminal status -> download the image URL.
const GMI_QUEUE = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey";
const GMI_POLL_MS = 2500;
const GMI_DEADLINE_MS = 55_000;

function makeGmiProvider(fetchFn: typeof fetch, sleep: Sleep): ImageProvider {
  return {
    async generate(prompt, apiKey) {
      const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const submit = await fetchFn(`${GMI_QUEUE}/requests`, {
        method: "POST", headers,
        body: JSON.stringify({ model: PINNED.gmicloud.model, payload: { prompt, size: "1024x1024" } }),
      });
      if (submit.status === 401 || submit.status === 403) throw new ProviderAuthError(`gmicloud ${submit.status}`);
      if (!submit.ok) throw new Error(`gmicloud submit ${submit.status}: ${(await submit.text().catch(() => "")).slice(0, 300)}`);
      const sub: any = await submit.json();
      const id = sub?.request_id ?? sub?.id;
      if (!id) throw new Error("gmicloud submit: no request id");

      const deadline = Date.now() + GMI_DEADLINE_MS;
      while (Date.now() < deadline) {
        await sleep(GMI_POLL_MS);
        const poll = await fetchFn(`${GMI_QUEUE}/requests/${id}`, { headers });
        if (!poll.ok) throw new Error(`gmicloud poll ${poll.status}`);
        const detail: any = await poll.json();
        const status = String(detail?.status ?? "");
        if (status === "failed" || status === "cancelled") {
          throw new Error(`gmicloud generation ${status}: ${String(detail?.error ?? "")}`.slice(0, 300));
        }
        if (status === "success") {
          const raw = detail?.outcome?.media_urls;
          const first = Array.isArray(raw)
            ? (typeof raw[0] === "string" ? raw[0] : raw[0]?.url)
            : (detail?.outcome?.image_url ?? detail?.outcome?.url);
          if (!first) throw new Error("gmicloud: success but no image url");
          const img = await fetchFn(first);
          if (!img.ok) throw new Error(`gmicloud image fetch ${img.status}`);
          const mime = img.headers.get("Content-Type")?.split(";")[0] || "image/png";
          return { bytes: await img.arrayBuffer(), mime };
        }
      }
      throw new Error("gmicloud generation timed out");
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${GMI_QUEUE}/requests`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return res.ok;
    },
  };
}

export function providerFor(name: string, fetchFn: typeof fetch = fetch, sleep: Sleep = realSleep): ImageProvider {
  if (name === "openai") return makeOpenAiProvider(fetchFn);
  if (name === "gmicloud") return makeGmiProvider(fetchFn, sleep);
  throw new Error(`unknown provider ${name}`);
}
