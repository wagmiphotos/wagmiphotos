import type { Services, GenerationRow } from "./types";
import { decryptSecret } from "./crypto";
import { deniedTerm } from "./denylist";
import { moderationFlagged } from "./moderation";
import {
  providerFor as realProviderFor, ProviderAuthError,
  type ImageProvider, type SyncImageProvider, type GeneratedImage,
} from "./providers";
import contract from "../../../contract.json";

export interface GenBucket { put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; }
export interface GenJobsCfg {
  kek?: string;
  moderationKey?: string;
  bucket?: GenBucket;
  publicUrlBase?: string;
  now: () => number;
  fetchFn?: typeof fetch;
  providerFor?: (name: string) => ImageProvider;
  uuid?: () => string;
  /** ctx.waitUntil in the worker; tests omit it so sync jobs run inline. */
  waitUntil?: (p: Promise<unknown>) => void;
}

export function monthKey(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 7);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp" };
/** Sweep: open jobs untouched this long get re-driven. */
export const SWEEP_STALE_SEC = 120;
/** Sweep: jobs this old are failed+refunded. Past OpenAI's ~10-min background
 *  retention nothing is recoverable, and a lost sync waitUntil can't resume. */
export const SWEEP_ABANDON_SEC = 900;
const SWEEP_BATCH = 20;

export type StartOutcome =
  | { kind: "accepted"; row: GenerationRow; used: number; cap: number; estSpendUsd: number }
  | { kind: "content_policy"; category: string }
  | { kind: "cap_reached"; used: number; cap: number }
  | { kind: "byok_unconfigured" }
  | { kind: "provider_error" };

function providerOf(cfg: GenJobsCfg, name: string): ImageProvider {
  return (cfg.providerFor ?? ((n: string) => realProviderFor(n, cfg.fetchFn ?? fetch)))(name);
}

/** Deterministic asset id derived from a gen id (the gen id's uuid part).
 *  Shared by publish() and terminalFail()'s durable-recovery check so both
 *  agree on the same key. */
function assetIdFor(genId: string): string {
  return genId.startsWith("gen_") ? genId.slice(4) : `${genId}-a`;
}

/** Terminal failure exactly once: only the transitioning caller refunds.
 *  Durable-aware: if the job's asset already exists, the user was billed for
 *  a DELIVERED image — recover to succeeded instead of refunding (constraint:
 *  never refund after insertGenerated). Covers a succeed() throw inside the
 *  sync path's publish and the sweep's abandon racing a mid-publish drive. */
async function terminalFail(
  s: Services, gen: { id: string; user_id: string; month: string; provider: string }, msg: string
): Promise<void> {
  try {
    const assetId = assetIdFor(gen.id);
    if (await s.assets.getAsset(assetId)) {
      if (await s.generations.succeed(gen.id, assetId)) {
        const pinned = (contract as any).byok_providers[gen.provider];
        if (pinned) {
          try { await s.byok.addSpend(gen.user_id, gen.month, pinned.price_per_image_usd); } catch (e) { console.error("gen addSpend failed", e); }
        }
      }
      return;
    }
  } catch (e) { console.error("gen terminal recovery check failed", e); } // fall through: fail+refund
  if (await s.generations.fail(gen.id, msg)) {
    try { await s.byok.refund(gen.user_id, gen.month); } catch (e) { console.error("gen refund failed", e); }
  }
}

// The async-generation start path. Ordering is load-bearing (inherited from
// tryByokGenerate): guardrails (fail-closed) -> atomic quota reserve -> job
// row -> provider submit. Failures after the reserve refund it (and an auth
// failure also disables the key). Nothing here waits for the image: async
// providers return after submit; sync providers run the whole job in
// waitUntil so the 202 returns immediately.
export async function startGeneration(
  i: { userId: string; collectionId: string; prompt: string }, s: Services, cfg: GenJobsCfg
): Promise<StartOutcome> {
  if (!cfg.kek || !cfg.bucket || !cfg.publicUrlBase) return { kind: "byok_unconfigured" };
  const row = await s.byok.get(i.userId);
  if (!row || !row.enabled) return { kind: "byok_unconfigured" };
  const pinned = (contract as any).byok_providers[row.provider];
  if (!pinned) return { kind: "byok_unconfigured" };

  const term = deniedTerm(i.prompt);
  if (term) return { kind: "content_policy", category: `denylist:${term}` };

  let apiKey: string;
  try { apiKey = await decryptSecret(row.key_ciphertext, cfg.kek); }
  catch (e) {
    console.error("byok decrypt failed", e);
    try { await s.byok.disable(i.userId, "decrypt_failed"); } catch (de) { console.error("byok disable failed", de); }
    return { kind: "provider_error" };
  }

  // openai users are moderated with their own key (the endpoint is free);
  // gmicloud users need the operator OPENAI_API_KEY. No key => never generate.
  const modKey = row.provider === "openai" ? apiKey : cfg.moderationKey;
  if (!modKey) return { kind: "byok_unconfigured" };
  let category: string | null;
  try { category = await moderationFlagged(i.prompt, modKey, cfg.fetchFn ?? fetch); }
  catch (e) { console.error("byok moderation unavailable", e); return { kind: "provider_error" }; }
  if (category) return { kind: "content_policy", category };

  const month = monthKey(cfg.now());
  if (!(await s.byok.reserve(i.userId, month, row.monthly_cap))) {
    let used = row.monthly_cap;
    try { used = (await s.byok.getUsage(i.userId, month)).count; } catch (e) { console.error("byok usage read failed", e); }
    return { kind: "cap_reached", used, cap: row.monthly_cap };
  }

  const id = `gen_${(cfg.uuid ?? (() => crypto.randomUUID()))()}`;
  try {
    await s.generations.create({ id, userId: i.userId, collectionId: i.collectionId, prompt: i.prompt, provider: row.provider, month });
  } catch (e) {
    console.error("gen row create failed", e);
    try { await s.byok.refund(i.userId, month); } catch (re) { console.error("gen refund failed", re); }
    return { kind: "provider_error" };
  }

  const provider = providerOf(cfg, row.provider);
  if (provider.mode === "async") {
    try {
      const jobId = await provider.submit(i.prompt, apiKey);
      await s.generations.setProviderJob(id, jobId);
    } catch (e) {
      console.error("gen submit failed", e);
      await terminalFail(s, { id, user_id: i.userId, month, provider: row.provider }, "provider submit failed");
      if (e instanceof ProviderAuthError) {
        try { await s.byok.disable(i.userId, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
      }
      return { kind: "provider_error" };
    }
  } else {
    // Sync provider (openai gpt-image-1, 13-20s: ducks the ~20s idle-kill).
    // The whole job runs after the 202; the ticket GET only reads D1 for it.
    const run = runSyncJob(id, i.userId, month, row.provider, i.prompt, provider, apiKey, s, cfg)
      .catch((e) => console.error("sync generation job crashed", e));
    if (cfg.waitUntil) cfg.waitUntil(run); else await run;
  }

  const fresh = await s.generations.get(id);
  let used = 1;
  let estSpendUsd = pinned.price_per_image_usd;
  try {
    const usage = await s.byok.getUsage(i.userId, month);
    used = usage.count;
    estSpendUsd = usage.est_spend_usd;
  } catch (e) { console.error("byok usage read failed", e); }
  return { kind: "accepted", row: fresh!, used, cap: row.monthly_cap, estSpendUsd };
}

async function runSyncJob(
  genId: string, userId: string, month: string, provider: string, prompt: string,
  syncProvider: SyncImageProvider, apiKey: string, s: Services, cfg: GenJobsCfg
): Promise<void> {
  // Claim so the sweep can't race a live sync run; updated_at refresh also
  // keeps the row out of listStale while we work.
  if (!(await s.generations.claim(genId))) return;
  try {
    const img = await syncProvider.generate(prompt, apiKey);
    await publish(genId, s, cfg, img);
  } catch (e) {
    console.error("sync generation failed", e);
    await terminalFail(s, { id: genId, user_id: userId, month, provider }, "generation failed");
    if (e instanceof ProviderAuthError) {
      try { await s.byok.disable(userId, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
    }
  }
}

// Durable persist + accounting. Deterministic asset id (the gen id's uuid
// part) makes retries idempotent: R2 re-puts the same key, the D1 insert is
// skipped when the row exists, and the guarded succeed() transitions once.
// Vector writes stay best-effort — spec'd as namespace-ONLY: user creations
// live in their collection, never in the shared library (decision 2).
async function publish(genId: string, s: Services, cfg: GenJobsCfg, img: GeneratedImage): Promise<void> {
  const row = await s.generations.get(genId);
  if (!row || (row.status !== "queued" && row.status !== "generating")) return;
  const pinned = (contract as any).byok_providers[row.provider];
  const assetId = assetIdFor(row.id);
  const key = `byok/${assetId}/original.${EXT[img.mime] ?? "png"}`;
  await cfg.bucket!.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
  const sourceUrl = `${cfg.publicUrlBase!.replace(/\/+$/, "")}/${key}`;
  if (!(await s.assets.getAsset(assetId))) {
    await s.assets.insertGenerated({
      id: assetId, prompt: row.prompt, sourceUrl, mime: img.mime,
      width: 1024, height: 1024, // requested size; providers may letterbox but 1024x1024 is what we ask for
      modelUsed: pinned.model, provider: row.provider, priceUsd: pinned.price_per_image_usd,
      createdBy: row.user_id, collectionId: row.collection_id,
    });
  }
  const transitioned = await s.generations.succeed(row.id, assetId);
  // Durable + paid past this point: best-effort bookkeeping only.
  if (transitioned) {
    try { await s.byok.addSpend(row.user_id, row.month, pinned.price_per_image_usd); } catch (e) { console.error("gen addSpend failed", e); }
  }
  try {
    const vec = await s.embedder.textEmbed(row.prompt);
    try { await s.vectorize.upsertNamespace(assetId, vec, row.collection_id); } catch (e) { console.error("gen namespace upsert failed", e); }
  } catch (e) { console.error("gen embed failed", e); }
}

// Poll-through drive: one short provider status check per call, under the
// atomic claim. Transient errors release the claim (next poll/sweep retries);
// auth errors are terminal. Sync jobs (no provider_job_id) are owned by their
// waitUntil — there is nothing to drive here.
export async function driveGeneration(genId: string, s: Services, cfg: GenJobsCfg): Promise<GenerationRow | null> {
  const row = await s.generations.get(genId);
  if (!row) return null;
  if (row.status !== "queued" && row.status !== "generating") return row;
  if (!row.provider_job_id) return row;
  if (!(await s.generations.claim(genId))) return row;
  try {
    const keyRow = await s.byok.get(row.user_id);
    if (!keyRow) { await terminalFail(s, row, "provider key removed"); return await s.generations.get(genId); }
    // NOTE: a disabled key still polls — the job is already paid for; only a
    // provider auth failure below is terminal.
    let apiKey: string;
    try { apiKey = await decryptSecret(keyRow.key_ciphertext, cfg.kek!); }
    catch { await terminalFail(s, row, "key decrypt failed"); return await s.generations.get(genId); }
    const provider = providerOf(cfg, row.provider);
    if (provider.mode !== "async") { await s.generations.release(genId); return row; }
    const st = await provider.check(row.provider_job_id, apiKey);
    if (st.state === "pending") { await s.generations.release(genId); return await s.generations.get(genId); }
    if (st.state === "failed") { await terminalFail(s, row, st.error); return await s.generations.get(genId); }
    await publish(genId, s, cfg, st.image);
    return await s.generations.get(genId);
  } catch (e) {
    console.error("gen drive failed", e);
    if (e instanceof ProviderAuthError) {
      await terminalFail(s, row, "provider auth failed");
      try { await s.byok.disable(row.user_id, "provider_auth_failed"); } catch (de) { console.error("byok disable failed", de); }
    } else {
      try { await s.generations.release(genId); } catch (re) { console.error("gen release failed", re); }
    }
    return await s.generations.get(genId);
  }
}

function epochSec(d1Datetime: string): number {
  return Math.floor(Date.parse(d1Datetime.replace(" ", "T") + "Z") / 1000);
}

// Cron backstop: finishes what nobody polled to completion. Rows a live
// driver is working on have a fresh updated_at (claim refreshes it), so
// listStale never hands us a job mid-drive.
export async function sweepGenerations(s: Services, cfg: GenJobsCfg): Promise<void> {
  const stale = await s.generations.listStale(SWEEP_STALE_SEC, SWEEP_BATCH);
  for (const row of stale) {
    try {
      if (cfg.now() - epochSec(row.created_at) > SWEEP_ABANDON_SEC) {
        await terminalFail(s, row, "abandoned: no completion within the retention window");
      } else if (row.provider_job_id) {
        await driveGeneration(row.id, s, cfg);
      }
      // Sync jobs without a provider_job_id can't be resumed (their waitUntil
      // died with the request) — only the age check above ever finishes them.
    } catch (e) { console.error("sweep item failed", e); }
  }
}
