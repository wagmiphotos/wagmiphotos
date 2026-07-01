import type { AssetRow, AssetStore, QueryStore, KeyStore } from "./types";

const ASSET_COLS =
  "id, prompt, source, source_id, thumb_url, medium_url, url, model_used, width, height, mime, source_url, locally_cached";

export function makeD1Stores(db: any): { assets: AssetStore; queries: QueryStore; keys: KeyStore } {
  const assets: AssetStore = {
    async getAsset(id) {
      const row = await db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).bind(id).first();
      return (row as AssetRow) ?? null;
    },
  };
  const queries: QueryStore = {
    async recordQuery({ normalized, original, assetId, similarity, built }) {
      const status = built ? "built" : "pending";
      await db.prepare(
        `INSERT INTO queries (normalized_prompt, original_prompt, count, status, last_asset_id, last_similarity)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(normalized_prompt) DO UPDATE SET
           count = queries.count + 1,
           original_prompt = excluded.original_prompt,
           last_similarity = excluded.last_similarity,
           last_seen = datetime('now'),
           last_asset_id = COALESCE(excluded.last_asset_id, queries.last_asset_id),
           status = CASE WHEN queries.status = 'built' THEN 'built' ELSE excluded.status END`
      ).bind(normalized, original, status, assetId, similarity).run();
    },
  };
  const keys: KeyStore = {
    async verifyKey(hash) {
      const row = await db.prepare("SELECT 1 FROM api_keys WHERE key_hash = ?").bind(hash).first();
      return row != null;
    },
    async addKey(hash) {
      await db.prepare("INSERT OR IGNORE INTO api_keys (key_hash) VALUES (?)").bind(hash).run();
    },
  };
  return { assets, queries, keys };
}
