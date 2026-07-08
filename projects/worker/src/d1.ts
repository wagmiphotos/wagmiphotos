import type {
  AssetRow, AssetStore, LibraryAssetRow, QueryStore, KeyStore,
  User, UserStore, SessionStore, LoginTokenStore,
  ByokRow, ByokStore, ByokUsage,
} from "./types";

// Reads select FROM live_assets (migration 0008): the view owns the
// dead_at IS NULL invariant, so dead assets are invisible to every read.
const ASSET_COLS =
  "id, prompt, source, source_id, model_used, width, height, mime, source_url, locally_cached";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function makeD1Stores(db: D1Database): {
  assets: AssetStore; queries: QueryStore; keys: KeyStore;
  users: UserStore; sessions: SessionStore; loginTokens: LoginTokenStore;
  byok: ByokStore;
} {
  const assets: AssetStore = {
    async getAsset(id) {
      const row = await db.prepare(`SELECT ${ASSET_COLS} FROM live_assets WHERE id = ?`).bind(id).first<AssetRow>();
      return row ?? null;
    },
    async searchAssets({ q, limit, offset }) {
      const tokens = q.split(/\s+/).filter(Boolean);
      const tail = "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
      const stmt = tokens.length
        ? db.prepare(
            `SELECT ${ASSET_COLS}, created_at FROM live_assets WHERE ${tokens.map(() => "prompt LIKE ? ESCAPE '\\'").join(" AND ")} ${tail}`
          ).bind(...tokens.map((t) => `%${escapeLike(t)}%`), limit, offset)
        : db.prepare(`SELECT ${ASSET_COLS}, created_at FROM live_assets ${tail}`).bind(limit, offset);
      const { results } = await stmt.all<LibraryAssetRow>();
      return results ?? [];
    },
    async getAssetsByIds(ids) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at FROM live_assets WHERE id IN (${marks})`
      ).bind(...ids).all<LibraryAssetRow>();
      return results ?? [];
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
           status = CASE WHEN queries.status IN ('built','building') THEN queries.status ELSE excluded.status END,
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
        "SELECT key_hash AS id, label, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
      ).bind(userId).all();
      return (results ?? []) as { id: string; label: string | null; created_at: string }[];
    },
    // Owner-scoped: a user can only delete their own keys. `id` is the key_hash
    // (a sha256 — not the key itself, so it's safe to expose to the owner).
    async deleteKey(userId, id) {
      await db.prepare("DELETE FROM api_keys WHERE key_hash = ? AND user_id = ?").bind(id, userId).run();
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
      const row = await db.prepare(
        "SELECT id, email, created_at, last_login, tos_version, tos_accepted_at, stripe_customer_id, stripe_subscription_id, plan_status, plan_current_period_end FROM users WHERE id = ?"
      ).bind(id).first<User>();
      return row ?? null;
    },
    async getByStripeCustomerId(customerId) {
      const row = await db.prepare(
        "SELECT id, email, created_at, last_login, tos_version, tos_accepted_at, stripe_customer_id, stripe_subscription_id, plan_status, plan_current_period_end FROM users WHERE stripe_customer_id = ?"
      ).bind(customerId).first<User>();
      return row ?? null;
    },
    async setStripeCustomer(userId, customerId) {
      await db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(customerId, userId).run();
    },
    async setSubscriptionByCustomer(customerId, f) {
      // Keyed by customer id (what the webhook carries). A 0-row update (customer
      // not yet linked) is a silent no-op — the checkout 'link' event sets it.
      await db.prepare(
        "UPDATE users SET stripe_subscription_id = ?, plan_status = ?, plan_current_period_end = ? WHERE stripe_customer_id = ?"
      ).bind(f.subscriptionId, f.planStatus, f.currentPeriodEnd, customerId).run();
    },
    async acceptTos(userId, version, ip, userAgent) {
      // Append the immutable audit row and refresh the current-status columns together.
      await db.batch([
        db.prepare("INSERT INTO tos_acceptances (user_id, tos_version, ip, user_agent) VALUES (?, ?, ?, ?)")
          .bind(userId, version, ip, userAgent),
        db.prepare("UPDATE users SET tos_version = ?, tos_accepted_at = datetime('now') WHERE id = ?")
          .bind(version, userId),
      ]);
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
      // Conditional sliding renewal: only rewrite expiry once it has slid by
      // >= a day, so the hot path writes at most ~once/day per session.
      await db.prepare(
        "UPDATE sessions SET expires_at = datetime('now','+30 days') WHERE token_hash = ? AND expires_at < datetime('now','+29 days')"
      ).bind(tokenHash).run();
    },
    async delete(tokenHash) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    },
    async purgeExpired() {
      await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
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
    async purgeExpired() {
      await db.prepare("DELETE FROM login_tokens WHERE expires_at <= datetime('now')").run();
    },
  };

  const byok: ByokStore = {
    async get(userId) {
      const row = await db.prepare(
        "SELECT user_id, provider, key_ciphertext, key_last4, enabled, monthly_cap, last_error, created_at, updated_at FROM byok_keys WHERE user_id = ?"
      ).bind(userId).first<ByokRow>();
      return row ?? null;
    },
    async put({ userId, provider, keyCiphertext, keyLast4, monthlyCap, enabled }) {
      await db.prepare(
        `INSERT INTO byok_keys (user_id, provider, key_ciphertext, key_last4, enabled, monthly_cap)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           provider = excluded.provider, key_ciphertext = excluded.key_ciphertext,
           key_last4 = excluded.key_last4, enabled = excluded.enabled,
           monthly_cap = excluded.monthly_cap, last_error = NULL, updated_at = datetime('now')`
      ).bind(userId, provider, keyCiphertext, keyLast4, enabled ? 1 : 0, monthlyCap).run();
    },
    async patch(userId, f) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const args: unknown[] = [];
      if (f.enabled != null) { sets.push("enabled = ?"); args.push(f.enabled ? 1 : 0); }
      if (f.monthlyCap != null) { sets.push("monthly_cap = ?"); args.push(f.monthlyCap); }
      await db.prepare(`UPDATE byok_keys SET ${sets.join(", ")} WHERE user_id = ?`).bind(...args, userId).run();
    },
    async delete(userId) {
      await db.prepare("DELETE FROM byok_keys WHERE user_id = ?").bind(userId).run();
    },
    async disable(userId, err) {
      await db.prepare(
        "UPDATE byok_keys SET enabled = 0, last_error = ?, updated_at = datetime('now') WHERE user_id = ?"
      ).bind(err, userId).run();
    },
    async getUsage(userId, month) {
      const row = await db.prepare(
        "SELECT count, est_spend_usd FROM byok_usage WHERE user_id = ? AND month = ?"
      ).bind(userId, month).first<ByokUsage>();
      return row ?? { count: 0, est_spend_usd: 0 };
    },
    async reserve(userId, month, cap) {
      await db.prepare("INSERT OR IGNORE INTO byok_usage (user_id, month) VALUES (?, ?)").bind(userId, month).run();
      // Single guarded UPDATE = the atomic cap check; two concurrent requests
      // cannot both pass a spent cap.
      const row = await db.prepare(
        "UPDATE byok_usage SET count = count + 1 WHERE user_id = ? AND month = ? AND count < ? RETURNING count"
      ).bind(userId, month, cap).first();
      return !!row;
    },
    async refund(userId, month) {
      await db.prepare(
        "UPDATE byok_usage SET count = MAX(count - 1, 0) WHERE user_id = ? AND month = ?"
      ).bind(userId, month).run();
    },
    async addSpend(userId, month, usd) {
      await db.prepare(
        "UPDATE byok_usage SET est_spend_usd = est_spend_usd + ? WHERE user_id = ? AND month = ?"
      ).bind(usd, userId, month).run();
    },
  };

  return { assets, queries, keys, users, sessions, loginTokens, byok };
}
