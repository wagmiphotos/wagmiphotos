export interface AssetRow {
  id: string; prompt: string; source: string; source_id: string | null;
  thumb_url: string | null; medium_url: string | null; url: string;
  model_used: string | null; width: number | null; height: number | null;
  mime: string | null; source_url: string | null; locally_cached: number;
}
export interface Match { id: string; score: number; }
export interface Clip { textEmbed(prompt: string): Promise<number[]>; }
export interface VectorizeStore { query(vector: number[], topK: number): Promise<Match[]>; }
export interface AssetStore { getAsset(id: string): Promise<AssetRow | null>; }
export interface QueryStore {
  recordQuery(i: { normalized: string; original: string; assetId: string | null; similarity: number; built: boolean }): Promise<void>;
}
export interface KeyStore { verifyKey(hash: string): Promise<boolean>; addKey(hash: string): Promise<void>; }
export interface RateLimiter { limit(key: string): Promise<boolean>; }
export interface Services {
  clip: Clip; vectorize: VectorizeStore; assets: AssetStore; queries: QueryStore; keys: KeyStore; rateLimiter: RateLimiter;
}
export interface Env {
  DB: any; VECTORIZE: any; RATE_LIMITER?: any;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MASTER_API_KEY?: string; CLIP_TEXT_EMBED_URL: string; CLIP_EMBED_TOKEN?: string;
  IMAGE_PRICE_USD?: string; FLOOR_SIM_MAX?: string; FLOOR_SIM_MIN?: string;
}
