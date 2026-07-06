import type {
  AssetRow, AssetStore, LibraryAssetRow, QueryStore, KeyStore,
  User, UserStore, SessionStore, LoginTokenStore,
} from "./types";

const ASSET_COLS =
  "id, prompt, source, source_id, thumb_url, medium_url, url, model_used, width, height, mime, source_url, locally_cached";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function makeD1Stores(db: any): {
  assets: AssetStore; queries: QueryStore; keys: KeyStore;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
} {
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
    async getKeyOwner(hash) {
      const row = await db.prepare("SELECT user_id FROM api_keys WHERE key_hash = ?").bind(hash).first();
      return (row?.user_id as string) ?? null;
    },
    async addKey(hash, userId, label) {
      await db.prepare("INSERT OR IGNORE INTO api_keys (key_hash, user_id, label) VALUES (?, ?, ?)")
        .bind(hash, userId, label).run();
    },
    async listByUser(userId) {
      const { results } = await db.prepare(
        "SELECT label, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
      ).bind(userId).all();
      return (results ?? []) as { label: string | null; created_at: string }[];
    },
  };

  const users: UserStore = {
    async upsertByEmail(id, email) {
      const row = await db.prepare(
        `INSERT INTO users (id, email) VALUES (?, ?)
         ON CONFLICT(email) DO UPDATE SET last_login = datetime('now')
         RETURNING id, email`
      ).bind(id, email).first();
      return row as { id: string; email: string };
    },
    async getById(id) {
      const row = await db.prepare("SELECT id, email, created_at, last_login FROM users WHERE id = ?").bind(id).first();
      return (row as User) ?? null;
    },
  };

  const sessions: SessionStore = {
    async create(userId, tokenHash) {
      await db.prepare(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
      ).bind(userId, tokenHash).run();
    },
    async resolve(tokenHash) {
      const row = await db.prepare(
        "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')"
      ).bind(tokenHash).first();
      return row ? { user_id: row.user_id as string } : null;
    },
    async touch(tokenHash) {
      await db.prepare("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE token_hash = ?").bind(tokenHash).run();
    },
    async delete(tokenHash) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    },
  };

  const loginTokens: LoginTokenStore = {
    async create(tokenHash, email, nonceHash) {
      await db.prepare(
        "INSERT INTO login_tokens (token_hash, email, nonce_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+15 minutes'))"
      ).bind(tokenHash, email, nonceHash).run();
    },
    async consume(tokenHash, nonceHash) {
      const row = await db.prepare(
        `UPDATE login_tokens SET used_at = datetime('now')
         WHERE token_hash = ? AND nonce_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
         RETURNING email`
      ).bind(tokenHash, nonceHash).first();
      return row ? { email: row.email as string } : null;
    },
  };

  return { assets, queries, keys, users, sessions, loginTokens };
}
