import type { EmailSender } from "./email";

export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  model_used: string | null; width: number | null; height: number | null;
  mime: string | null; source_url: string | null; locally_cached: number;
}
export interface LibraryAssetRow extends AssetRow { created_at: string; }
export interface Match { id: string; score: number; }
export interface Embedder { textEmbed(prompt: string): Promise<number[]>; }
export interface VectorizeStore { query(vector: number[], topK: number): Promise<Match[]>; }
export interface AssetStore {
  getAsset(id: string): Promise<AssetRow | null>;
  searchAssets(i: { q: string; limit: number; offset: number }): Promise<LibraryAssetRow[]>;
  /** Batch lookup for the semantic-search hydration path; missing ids are simply absent (no error). */
  getAssetsByIds(ids: string[]): Promise<LibraryAssetRow[]>;
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
}
export interface UserStore {
  upsertByEmail(id: string, email: string): Promise<{ id: string; email: string }>;
  getById(id: string): Promise<User | null>;
  acceptTos(userId: string, version: string, ip: string | null, userAgent: string | null): Promise<void>;
  getByStripeCustomerId(customerId: string): Promise<User | null>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  setSubscriptionByCustomer(customerId: string, f: { subscriptionId: string | null; planStatus: string; currentPeriodEnd: string | null }): Promise<void>;
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
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  email: EmailSender; stripe: StripeClient; byok: ByokStore;
}
export interface Env {
  DB: D1Database; VECTORIZE_0: VectorizeIndex; VECTORIZE_1: VectorizeIndex; VECTORIZE_2: VectorizeIndex; AI: Ai; RATE_LIMITER?: RateLimitBinding;
  RATE_LIMITER_PAID?: RateLimitBinding;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string;
  /** "true"/"1" opens dev-only lanes (dev API principal, console magic links). NEVER set in production. */
  DEV_MODE?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
  GITHUB_REPO?: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
  PUBLIC_SITE_URL?: string; PUBLIC_API_BASE_URL?: string;
  /** Base URL for locally_cached asset objects (B2/CDN origin); see asset-urls.ts. */
  ASSET_BASE_URL?: string;
  STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_PRICE_ID?: string;
}
