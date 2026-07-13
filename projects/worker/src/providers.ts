import contract from "../../../contract.json";

// Direct HTTP adapters for the two BYOK providers. Models are pinned in
// contract.json (byok_providers) — the public API has no model parameter.
export interface GeneratedImage { bytes: ArrayBuffer; mime: string; }
export class ProviderAuthError extends Error {}
export type ProviderJobState =
  | { state: "pending" }
  | { state: "done"; image: GeneratedImage }
  | { state: "failed"; error: string };
export interface AsyncImageProvider {
  mode: "async";
  submit(prompt: string, apiKey: string): Promise<string>;   // provider job id
  check(jobId: string, apiKey: string): Promise<ProviderJobState>; // ONE short status call (+download on success)
  validateKey(apiKey: string): Promise<boolean>;
}
export interface SyncImageProvider {
  mode: "sync";
  generate(prompt: string, apiKey: string): Promise<GeneratedImage>;
  validateKey(apiKey: string): Promise<boolean>;
}
export type ImageProvider = AsyncImageProvider | SyncImageProvider;

const PINNED: Record<string, { model: string; price_per_image_usd: number }> = (contract as any).byok_providers;

// Every BYOK outbound fetch is bounded so a hung provider/moderation call
// never hangs the user's request (and a stranded refund).
const OPENAI_HOST_MODEL = "gpt-5-mini"; // cheap Responses host; the image tool does the actual work
const OPENAI_SUBMIT_TIMEOUT_MS = 15_000;
const OPENAI_POLL_TIMEOUT_MS = 15_000;
const OPENAI_VALIDATE_TIMEOUT_MS = 10_000;
const GMI_SUBMIT_TIMEOUT_MS = 15_000;
const GMI_POLL_TIMEOUT_MS = 15_000;
const GMI_DOWNLOAD_TIMEOUT_MS = 30_000;
const GMI_VALIDATE_TIMEOUT_MS = 10_000;

// GMI's returned image URL is provider-controlled and lands verbatim on a
// public wagmi.photos origin: guard both what it claims to be and how big it is.
const GMI_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const GMI_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// The success payload's image URL is provider-controlled and gets fetched by
// the worker, so treat it as an SSRF vector: require https and reject targets
// that resolve as a literal internal/loopback/link-local address. (Full
// DNS-rebinding defense isn't reachable from the Workers fetch API — this
// blocks the direct cases before we ever open the connection.)
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h.includes(":")) { // IPv6 literal: loopback, link-local fe80::/10, unique-local fc00::/7
    return h === "::1" || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") ||
      h.startsWith("feb") || h.startsWith("fc") || h.startsWith("fd");
  }
  return false;
}
function assertPublicHttpsUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("gmicloud: malformed image url"); }
  if (u.protocol !== "https:") throw new Error(`gmicloud: image url must be https (got ${u.protocol})`);
  if (isInternalHost(u.hostname)) throw new Error("gmicloud: image url targets a non-public host");
}

const OPENAI_API = "https://api.openai.com/v1";

function makeOpenAiProvider(fetchFn: typeof fetch): AsyncImageProvider {
  return {
    mode: "async",
    async submit(prompt, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // background+store: OpenAI runs the job server-side; every connection
        // we hold is short — the ~20s silent-connection idle-kill (diagnosed
        // live 2026-07-09) can't bite. Prompt passed verbatim via instruction
        // (fidelity verified by scripts/probe-openai-background.sh).
        body: JSON.stringify({
          model: OPENAI_HOST_MODEL, background: true, store: true,
          input: `Call the image generation tool with exactly this prompt, verbatim, then stop: ${prompt}`,
          tools: [{ type: "image_generation", model: PINNED.openai.model, size: "1024x1024", quality: "medium", output_format: "webp", output_compression: 85 }],
          tool_choice: "required",
        }),
        signal: AbortSignal.timeout(OPENAI_SUBMIT_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai responses ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const body: any = await res.json();
      if (!body?.id) throw new Error("openai responses: no id");
      return String(body.id);
    },
    async check(jobId, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/responses/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(OPENAI_POLL_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai poll ${res.status}`);
      const body: any = await res.json();
      const status = String(body?.status ?? "");
      if (status === "queued" || status === "in_progress") return { state: "pending" };
      if (status !== "completed") {
        const msg = body?.error?.message ?? body?.incomplete_details?.reason ?? "";
        return { state: "failed", error: `openai background ${status}: ${msg}`.slice(0, 300) };
      }
      const call = (body?.output ?? []).find((o: any) => o?.type === "image_generation_call" && typeof o?.result === "string");
      if (!call) return { state: "failed", error: "openai background completed without an image_generation_call result" };
      const fmt = typeof call.output_format === "string" ? call.output_format : "webp";
      return { state: "done", image: { bytes: Uint8Array.from(atob(call.result), (c) => c.charCodeAt(0)).buffer, mime: `image/${fmt}` } };
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${OPENAI_API}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(OPENAI_VALIDATE_TIMEOUT_MS),
      });
      return res.ok;
    },
  };
}

// GMI Cloud's async request queue (same API genblaze_gmicloud wraps):
// submit -> poll until a terminal status -> download the image URL. Each
// step below is one short HTTP call; the caller (poll-through GET / sweep)
// owns the cadence between submit and check — no in-process polling loop.
const GMI_QUEUE = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey";

function makeGmiProvider(fetchFn: typeof fetch): AsyncImageProvider {
  const headers = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
  return {
    mode: "async",
    async submit(prompt, apiKey) {
      const submit = await fetchFn(`${GMI_QUEUE}/requests`, {
        method: "POST", headers: headers(apiKey),
        body: JSON.stringify({ model: PINNED.gmicloud.model, payload: { prompt, size: "1024x1024" } }),
        signal: AbortSignal.timeout(GMI_SUBMIT_TIMEOUT_MS),
      });
      if (submit.status === 401 || submit.status === 403) throw new ProviderAuthError(`gmicloud ${submit.status}`);
      if (!submit.ok) throw new Error(`gmicloud submit ${submit.status}: ${(await submit.text().catch(() => "")).slice(0, 300)}`);
      const sub: any = await submit.json();
      const id = sub?.request_id ?? sub?.id;
      if (!id) throw new Error("gmicloud submit: no request id");
      return String(id);
    },
    // ONE status call per invocation; the caller (poll-through GET / sweep)
    // owns the cadence. Download only happens on the success transition.
    async check(jobId, apiKey) {
      const poll = await fetchFn(`${GMI_QUEUE}/requests/${jobId}`, {
        headers: headers(apiKey), signal: AbortSignal.timeout(GMI_POLL_TIMEOUT_MS),
      });
      if (poll.status === 401 || poll.status === 403) throw new ProviderAuthError(`gmicloud ${poll.status}`);
      if (!poll.ok) throw new Error(`gmicloud poll ${poll.status}`);
      const detail: any = await poll.json();
      const status = String(detail?.status ?? "");
      if (status === "failed" || status === "cancelled") {
        return { state: "failed", error: `gmicloud generation ${status}: ${String(detail?.error ?? "")}`.slice(0, 300) };
      }
      if (status !== "success") return { state: "pending" };
      const raw = detail?.outcome?.media_urls;
      const first = Array.isArray(raw)
        ? (typeof raw[0] === "string" ? raw[0] : raw[0]?.url)
        : (detail?.outcome?.image_url ?? detail?.outcome?.url);
      if (!first) throw new Error("gmicloud: success but no image url");
      assertPublicHttpsUrl(first);
      const img = await fetchFn(first, { signal: AbortSignal.timeout(GMI_DOWNLOAD_TIMEOUT_MS) });
      if (!img.ok) throw new Error(`gmicloud image fetch ${img.status}`);

      // Provider-controlled URL landing on a public bucket: pin the mime
      // to an allowlist and cap the size before and after the download.
      const rawType = img.headers.get("Content-Type");
      const mime = rawType ? rawType.split(";")[0].trim() : "image/png";
      if (rawType && !GMI_ALLOWED_MIME.has(mime)) throw new Error(`gmicloud: unexpected content type ${mime}`);
      const declaredLen = img.headers.get("Content-Length");
      if (declaredLen && Number(declaredLen) > GMI_MAX_IMAGE_BYTES) throw new Error(`gmicloud: image too large (${declaredLen} bytes)`);
      const bytes = await img.arrayBuffer();
      if (bytes.byteLength > GMI_MAX_IMAGE_BYTES) throw new Error(`gmicloud: image too large (${bytes.byteLength} bytes)`);
      return { state: "done", image: { bytes, mime } };
    },
    async validateKey(apiKey) {
      const res = await fetchFn(`${GMI_QUEUE}/requests`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(GMI_VALIDATE_TIMEOUT_MS),
      });
      return res.ok;
    },
  };
}

export function providerFor(name: string, fetchFn: typeof fetch = fetch): ImageProvider {
  if (name === "openai") return makeOpenAiProvider(fetchFn);
  if (name === "gmicloud") return makeGmiProvider(fetchFn);
  throw new Error(`unknown provider ${name}`);
}
