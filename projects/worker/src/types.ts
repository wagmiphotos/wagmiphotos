import type { EmailSender } from "./email";

export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  model_used: string | null; width: number | null; height: number | null;
  mime: string | null; source_url: string | null; locally_cached: number;
  like_count: number;
}
export interface LibraryAssetRow extends AssetRow { created_at: string; }
export interface CollectionRow {
  id: string; owner_user_id: string; name: string; theme_prompt: string;
  created_at: string; updated_at: string;
}
export interface CollectionSummary extends CollectionRow { image_count: number; total_serves: number; search_count: number; }
export interface CollectionImageRow extends LibraryAssetRow { serve_count: number; }
export interface CollectionPreviewRow { collection_id: string; id: string; prompt: string; source_url: string | null; locally_cached: number; }
export interface CollectionStore {
  create(c: { id: string; ownerUserId: string; name: string; themePrompt: string }): Promise<void>;
  get(id: string): Promise<CollectionRow | null>;
  listByOwner(userId: string): Promise<CollectionSummary[]>;
  countByOwner(userId: string): Promise<number>;
  patch(id: string, f: { name?: string; themePrompt?: string }): Promise<void>;
  delete(id: string): Promise<void>;
  /** Public browse: every collection, most-served first. q filters by name (LIKE). */
  browse(i: { q: string; limit: number; offset: number }): Promise<CollectionSummary[]>;
  /** Fire-and-forget stat for scoped reads (library search + scoped generate). */
  bumpSearchCount(id: string): Promise<void>;
}
export interface Match { id: string; score: number; }
export interface Embedder { textEmbed(prompt: string): Promise<number[]>; }
export interface VectorizeStore {
  query(vector: number[], topK: number): Promise<Match[]>;
  /** Shard-routed write (fnv1a32(id) % shards) — BYOK in-request ingest. */
  upsert(id: string, vector: number[]): Promise<void>;
  /** Collection-scoped query against the namespaced collections index only.
   *  Returns [] when the index is not bound (local dev). */
  queryNamespace(vector: number[], namespace: string, topK: number): Promise<Match[]>;
  /** Best-effort second write for collection assets (namespace = collection id). */
  upsertNamespace(id: string, vector: number[], namespace: string): Promise<void>;
  /** Removes ids from the owning shard AND the collections index. Throws on
   *  failure — callers own the try/catch (D1 tombstones are the source of
   *  truth; orphans are tolerated by every read path). */
  deleteByIds(ids: string[]): Promise<void>;
}
export interface AssetStore {
  getAsset(id: string): Promise<AssetRow | null>;
  searchAssets(i: { q: string; limit: number; offset: number; collectionId?: string }): Promise<LibraryAssetRow[]>;
  /** Batch lookup for the semantic-search hydration path; missing ids are simply absent (no error). */
  getAssetsByIds(ids: string[]): Promise<LibraryAssetRow[]>;
  /** Insert a BYOK-generated asset. source='byok'; the row serves from
   *  source_url until the demand-first rehost derives B2 sizes (0008). */
  insertGenerated(a: { id: string; prompt: string; sourceUrl: string; mime: string; width: number | null; height: number | null; modelUsed: string; provider: string; priceUsd: number; createdBy: string; collectionId: string | null }): Promise<void>;
  /** Owner-facing management list: public shape + serve_count. */
  listByCollection(i: { collectionId: string; limit: number; offset: number }): Promise<CollectionImageRow[]>;
  /** Live membership check for owner image deletion. */
  getCollectionMember(assetId: string, collectionId: string): Promise<AssetRow | null>;
  tombstoneAsset(id: string): Promise<void>;
  /** Tombstones all live members; returns their ids for vector cleanup. */
  tombstoneByCollection(collectionId: string): Promise<string[]>;
  /** Fire-and-forget serve counter (hit/approximate generation returns only). */
  bumpServeCount(id: string): Promise<void>;
  /** Idempotent like; returns the post-state like_count. */
  likeAsset(userId: string, id: string): Promise<number>;
  /** Idempotent unlike; returns the post-state like_count. */
  unlikeAsset(userId: string, id: string): Promise<number>;
  /** Subset of `ids` the user has liked (for the per-image `liked` flag). */
  likedByUser(userId: string, ids: string[]): Promise<string[]>;
  /** Likes-ranked browse page; unscoped excludes collection assets. */
  browseByLikes(i: { limit: number; offset: number; collectionId?: string }): Promise<LibraryAssetRow[]>;
  /** Public library size for /v1/home — live, unscoped rows only. */
  countLibraryAssets(): Promise<number>;
  /** Homepage strip: top-liked rehosted (locally_cached=1) public rows,
   *  newest-first tiebreak — tiles must always serve fast B2 thumbs. */
  showcaseAssets(limit: number): Promise<LibraryAssetRow[]>;
  /** Up to `per` newest live assets for each listed collection (browse-card previews). */
  previewsByCollections(collectionIds: string[], per: number): Promise<CollectionPreviewRow[]>;
}
export interface QueryStore {
  /** Upserts the query row and returns the row's effective generate state after merging. */
  recordQuery(i: { normalized: string; original: string; assetId: string | null; similarity: number; built: boolean; generate: boolean }): Promise<boolean>;
}
export interface User {
  id: string; email: string; created_at: string; last_login: string | null;
  tos_version: string | null; tos_accepted_at: string | null;
  stripe_customer_id: string | null; stripe_subscription_id: string | null;
  plan_status: string | null; plan_current_period_end: string | null;
  // 1 when the active subscription is set to cancel at period end (still paid
  // until plan_current_period_end, but not renewing). Optional: absent/0 => renewing.
  plan_cancel_at_period_end?: number | null;
}
export interface UserStore {
  upsertByEmail(id: string, email: string): Promise<{ id: string; email: string }>;
  getById(id: string): Promise<User | null>;
  acceptTos(userId: string, version: string, ip: string | null, userAgent: string | null): Promise<void>;
  getByStripeCustomerId(customerId: string): Promise<User | null>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  setSubscriptionByCustomer(customerId: string, f: { subscriptionId: string | null; planStatus: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }): Promise<void>;
}
export interface SessionStore {
  create(userId: string, tokenHash: string): Promise<void>;
  resolve(tokenHash: string): Promise<{ user_id: string } | null>;
  touch(tokenHash: string): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  /** Best-effort GC of rows past expiry. */
  purgeExpired(): Promise<void>;
}
export interface LoginTokenStore {
  create(tokenHash: string, email: string, nonceHash: string): Promise<void>;
  consume(tokenHash: string, nonceHash: string): Promise<{ email: string } | null>;
  /** Best-effort GC of rows past expiry. */
  purgeExpired(): Promise<void>;
}
export interface KeyStore {
  getKeyOwner(hash: string): Promise<string | null>;
  addKey(hash: string, userId: string, label: string | null): Promise<void>;
  listByUser(userId: string): Promise<{ id: string; label: string | null; created_at: string }[]>;
  deleteKey(userId: string, id: string): Promise<void>;
}
export interface ByokRow {
  user_id: string; provider: "openai" | "gmicloud"; key_ciphertext: string; key_last4: string;
  enabled: number; monthly_cap: number; last_error: string | null; created_at: string; updated_at: string;
}
export interface ByokUsage { count: number; est_spend_usd: number; }
export interface ByokStore {
  get(userId: string): Promise<ByokRow | null>;
  put(i: { userId: string; provider: string; keyCiphertext: string; keyLast4: string; monthlyCap: number; enabled: boolean }): Promise<void>;
  patch(userId: string, f: { enabled?: boolean; monthlyCap?: number }): Promise<void>;
  delete(userId: string): Promise<void>;
  /** Auth failure at the provider: flip enabled off and record why. */
  disable(userId: string, err: string): Promise<void>;
  getUsage(userId: string, month: string): Promise<ByokUsage>;
  /** Atomically take one unit of quota; false when the cap is already spent. */
  reserve(userId: string, month: string, cap: number): Promise<boolean>;
  refund(userId: string, month: string): Promise<void>;
  addSpend(userId: string, month: string, usd: number): Promise<void>;
  /** Lifetime successful generations (net of refunds) summed across all months. */
  totalGenerated(userId: string): Promise<number>;
}
export interface GenerationRow {
  id: string; user_id: string; collection_id: string; prompt: string;
  provider: string; provider_job_id: string | null;
  status: "queued" | "generating" | "succeeded" | "failed";
  asset_id: string | null; error: string | null; month: string;
  attempts: number; claimed_at: string | null; created_at: string; updated_at: string;
}
export interface GenerationStore {
  create(g: { id: string; userId: string; collectionId: string; prompt: string; provider: string; month: string }): Promise<void>;
  get(id: string): Promise<GenerationRow | null>;
  /** Records the provider-side job id and moves queued -> generating. */
  setProviderJob(id: string, providerJobId: string): Promise<void>;
  /** Atomic drive claim (60s TTL): true when THIS caller may touch the provider.
   *  Also bumps attempts and refreshes updated_at (keeps the row out of listStale). */
  claim(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
  /** Terminal transitions are guarded (status IN queued/generating) and return
   *  whether THIS call transitioned — the caller refunds/accounts only on true. */
  succeed(id: string, assetId: string): Promise<boolean>;
  fail(id: string, error: string): Promise<boolean>;
  /** Open jobs whose updated_at is older than olderThanSec — sweep targets. */
  listStale(olderThanSec: number, limit: number): Promise<GenerationRow[]>;
  /** Count of the user's still-open (queued|generating) generations — the concurrency gate. */
  countOpenByUser(userId: string): Promise<number>;
  /** Owner-scoped open generations in one collection, newest first — powers refresh re-attach. */
  listPendingByCollection(collectionId: string, userId: string, limit: number): Promise<GenerationRow[]>;
}
export interface RateLimiter { limit(key: string): Promise<boolean>; }
/** Minimal structural type for the unsafe `ratelimit` binding (no exported type in workers-types). */
export interface RateLimitBinding { limit(opts: { key: string }): Promise<{ success: boolean }>; }
export interface StripeClient {
  createCustomer(a: { email: string; userId: string }): Promise<{ id: string }>;
  createCheckoutSession(a: { customerId: string; userId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortalSession(a: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}
export interface Services {
  embedder: Embedder; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore;
  keys: KeyStore; rateLimiter: RateLimiter; rateLimiterPaid: RateLimiter;
  rateLimiterSearch: RateLimiter; rateLimiterSearchUser: RateLimiter;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  email: EmailSender; stripe: StripeClient; byok: ByokStore; collections: CollectionStore;
  generations: GenerationStore;
}
export interface Env {
  DB: D1Database; VECTORIZE_0: VectorizeIndex; VECTORIZE_1: VectorizeIndex; VECTORIZE_2: VectorizeIndex;
  /** Namespaced collections index (namespace = collection id); optional so local dev degrades. */
  VECTORIZE_COLL?: VectorizeIndex;
  AI: Ai; RATE_LIMITER?: RateLimitBinding;
  RATE_LIMITER_PAID?: RateLimitBinding;
  RATE_LIMITER_SEARCH?: RateLimitBinding;
  RATE_LIMITER_SEARCH_USER?: RateLimitBinding;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string;
  /** "true"/"1" opens dev-only lanes (dev API principal, console magic links). NEVER set in production. */
  DEV_MODE?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string; LIBRARY_FLOOR_SIM?: string;
  GITHUB_REPO?: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
  PUBLIC_SITE_URL?: string; PUBLIC_API_BASE_URL?: string;
  /** Base URL for locally_cached asset objects (B2/CDN origin); see asset-urls.ts. */
  ASSET_BASE_URL?: string;
  STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_PRICE_ID?: string;
  /** BYOK: 32-byte base64 KEK for user provider keys (wrangler secret). */
  BYOK_KEK?: string;
  /** BYOK: operator OpenAI key for moderating gmicloud-key users (wrangler secret). */
  OPENAI_API_KEY?: string;
  /** BYOK: public base URL of the BYOK_ORIGINALS bucket. */
  BYOK_PUBLIC_URL_BASE?: string;
  BYOK_ORIGINALS?: R2Bucket;
}
