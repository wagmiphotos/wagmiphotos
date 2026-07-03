import type { AssetRow, AssetStore, LibraryAssetRow, QueryStore, KeyStore } from "./types";

const ASSET_COLS =
  "id, prompt, source, source_id, thumb_url, medium_url, url, model_used, width, height, mime, source_url, locally_cached";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function makeD1Stores(db: any): { assets: AssetStore; queries: QueryStore; keys: KeyStore } {
  const assets: AssetStore = {
    async getAsset(id) {
      const row = await db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).bind(id).first();
      return (row as AssetRow) ?? null;
    },
    async searchAssets({ q, limit, offset }) {
      const tokens = q.split(/\s+/).filter(Boolean);
      const tail = "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
      const stmt = tokens.length
        ? db.prepare(
            `SELECT ${ASSET_COLS}, created_at FROM assets WHERE ${tokens.map(() => "prompt LIKE ? ESCAPE '\\'").join(" AND ")} ${tail}`
          ).bind(...tokens.map((t) => `%${escapeLike(t)}%`), limit, offset)
        : db.prepare(`SELECT ${ASSET_COLS}, created_at FROM assets ${tail}`).bind(limit, offset);
      const { results } = await stmt.all();
      return (results ?? []) as LibraryAssetRow[];
    },
  };
  const queries: QueryStore = {
    async recordQuery({ normalized, original, assetId, similarity, built, generate }) {
      const status = built ? "built" : "pending";
      // generate is forward-only to 1: one request asking for generation wins over any opt-out
      const row = await db.prepare(
        `INSERT INTO queries (normalized_prompt, original_prompt, count, status, last_asset_id, last_similarity, generate)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(normalized_prompt) DO UPDATE SET
           count = queries.count + 1,
           original_prompt = excluded.original_prompt,
           last_similarity = excluded.last_similarity,
           last_seen = datetime('now'),
           last_asset_id = COALESCE(excluded.last_asset_id, queries.last_asset_id),
           status = CASE WHEN queries.status = 'built' THEN 'built' ELSE excluded.status END,
           generate = MAX(queries.generate, excluded.generate)
         RETURNING generate`
      ).bind(normalized, original, status, assetId, similarity, generate ? 1 : 0).first();
      return row ? row.generate === 1 : generate;
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
