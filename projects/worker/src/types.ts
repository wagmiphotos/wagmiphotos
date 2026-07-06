import type { EmailSender } from "./email";

export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  thumb_url: string | null; medium_url: string | null; url: string;
  model_used: string | null; width: number | null; height: number | null;
  mime: string | null; source_url: string | null; locally_cached: number;
}
export interface LibraryAssetRow extends AssetRow { created_at: string; }
export interface Match { id: string; score: number; }
export interface Clip { textEmbed(prompt: string): Promise<number[]>; }
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
}
export interface LoginTokenStore {
  create(tokenHash: string, email: string, nonceHash: string): Promise<void>;
  consume(tokenHash: string, nonceHash: string): Promise<{ email: string } | null>;
}
export interface KeyStore {
  getKeyOwner(hash: string): Promise<string | null>;
  addKey(hash: string, userId: string, label: string | null): Promise<void>;
  listByUser(userId: string): Promise<{ label: string | null; created_at: string }[]>;
}
export interface RateLimiter { limit(key: string): Promise<boolean>; }
export interface Services {
  clip: Clip; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore;
  keys: KeyStore; rateLimiter: RateLimiter;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  email: EmailSender;
}
export interface Env {
  DB: any; VECTORIZE: any; RATE_LIMITER?: any;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string; CLIP_TEXT_EMBED_URL: string; CLIP_EMBED_TOKEN?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
  GITHUB_REPO?: string;
  PUBLIC_SITE_URL?: string; PUBLIC_API_BASE_URL?: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
}
