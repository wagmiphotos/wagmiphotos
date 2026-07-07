import type { EmailSender } from "./email";

export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  thumb_url: string | null; medium_url: string | null; url: string;
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
}
export interface QueryStore {
  /** Upserts the query row and returns the row's effective generate state after merging. */
  recordQuery(i: { normalized: string; original: string; assetId: string | null; similarity: number; built: boolean; generate: boolean }): Promise<boolean>;
}
export interface User { id: string; email: string; created_at: string; last_login: string | null; }
export interface UserStore {
  upsertByEmail(id: string, email: string): Promise<{ id: string; email: string }>;
  getById(id: string): Promise<User | null>;
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
export interface RateLimiter { limit(key: string): Promise<boolean>; }
/** Minimal structural type for the unsafe `ratelimit` binding (no exported type in workers-types). */
export interface RateLimitBinding { limit(opts: { key: string }): Promise<{ success: boolean }>; }
export interface Services {
  embedder: Embedder; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore;
  keys: KeyStore; rateLimiter: RateLimiter;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  email: EmailSender;
}
export interface Env {
  DB: D1Database; VECTORIZE_0: VectorizeIndex; VECTORIZE_1: VectorizeIndex; VECTORIZE_2: VectorizeIndex; AI: Ai; RATE_LIMITER?: RateLimitBinding;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string;
  /** "true"/"1" opens dev-only lanes (dev API principal, console magic links). NEVER set in production. */
  DEV_MODE?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
  GITHUB_REPO?: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
  PUBLIC_SITE_URL?: string; PUBLIC_API_BASE_URL?: string;
}
