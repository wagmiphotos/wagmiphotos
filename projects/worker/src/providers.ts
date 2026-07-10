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
// 300s: community/vendor guidance for image endpoints (medium ~44-80s,
// high p95 ~280s); raising only this layer — the others stay tight.
const OPENAI_GENERATE_TIMEOUT_MS = 300_000;
const OPENAI_VALIDATE_TIMEOUT_MS = 10_000;
const GMI_SUBMIT_TIMEOUT_MS = 15_000;
const GMI_POLL_TIMEOUT_MS = 15_000;
const GMI_DOWNLOAD_TIMEOUT_MS = 30_000;
const GMI_VALIDATE_TIMEOUT_MS = 10_000;

// GMI's returned image URL is provider-controlled and lands verbatim on a
// public wagmi.photos origin: guard both what it claims to be and how big it is.
const GMI_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const GMI_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const OPENAI_API = "https://api.openai.com/v1";

/** Reads an SSE body and returns the parsed `data:` payload of the first
 *  event whose `type` matches; null when the stream ends without one. Events
 *  are blank-line separated; a partial image (~2MB base64) is the largest
 *  single block, so peak buffering stays bounded per event. */
async function readSseEvent(res: Response, wantType: string): Promise<any | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    // SSE permits \r\n line endings; JSON payloads escape any literal \r, so
    // stripping it per-chunk is loss-free and \r can't span a chunk boundary.
    if (value) buf += decoder.decode(value, { stream: true }).replace(/\r/g, "");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d?.type === wantType) {
            reader.cancel().catch(() => { /* stream already finished */ });
            return d;
          }
        } catch { /* non-JSON data line: ignore */ }
      }
    }
    if (done) return null;
  }
}

function makeOpenAiProvider(fetchFn: typeof fetch): ImageProvider {
  return {
    mode: "sync" as const,
    async generate(prompt, apiKey) {
      const res = await fetchFn(`${OPENAI_API}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // quality pinned to medium: matches the contract price estimate ($0.04/img)
        // and avoids auto resolving to high (~4x cost, slower generations).
        // webp@85: ~10x smaller payload. stream + partial_images=1: OpenAI's
        // gateway intermittently kills SILENT image connections after ~20s
        // (billed but undelivered — diagnosed live 2026-07-09; gpt-image-2
        // medium runs 44-80s). SSE events keep the connection non-idle; only
        // the completed event carries the final image (~$0.003 partial cost).
        body: JSON.stringify({ model: PINNED.openai.model, prompt, n: 1, size: "1024x1024", quality: "medium", output_format: "webp", output_compression: 85, stream: true, partial_images: 1 }),
        signal: AbortSignal.timeout(OPENAI_GENERATE_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`openai ${res.status}`);
      if (!res.ok) throw new Error(`openai images ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const completed: any = await readSseEvent(res, "image_generation.completed");
      const b64 = completed?.b64_json;
      if (typeof b64 !== "string") throw new Error("openai images: stream ended without a completed image");
      const fmt = typeof completed.output_format === "string" ? completed.output_format : "webp";
      return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, mime: `image/${fmt}` };
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
