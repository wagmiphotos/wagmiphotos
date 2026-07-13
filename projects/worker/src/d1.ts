import type {
  AssetRow, AssetStore, LibraryAssetRow, QueryStore, KeyStore,
  User, UserStore, SessionStore, LoginTokenStore,
  ByokRow, ByokStore, ByokUsage,
  CollectionStore, CollectionRow, CollectionSummary, CollectionImageRow, CollectionPreviewRow,
  GenerationRow, GenerationStore,
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
  byok: ByokStore; collections: CollectionStore; generations: GenerationStore;
} {
  const assets: AssetStore = {
    async getAsset(id) {
      const row = await db.prepare(`SELECT ${ASSET_COLS} FROM live_assets WHERE id = ?`).bind(id).first<AssetRow>();
      return row ?? null;
    },
    async searchAssets({ q, limit, offset, collectionId }) {
      const tokens = q.split(/\s+/).filter(Boolean);
      const where: string[] = tokens.map(() => "prompt LIKE ? ESCAPE '\\'");
      const args: unknown[] = tokens.map((t) => `%${escapeLike(t)}%`);
      // Scoped search sees the collection; unscoped search must never surface
      // collection assets — the shared library is operator-curated (spec
      // 2026-07-10, decision 2).
      if (collectionId) { where.push("collection_id = ?"); args.push(collectionId); }
      else { where.push("collection_id IS NULL"); }
      const cond = where.length ? `WHERE ${where.join(" AND ")} ` : "";
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at FROM live_assets ${cond}ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).bind(...args, limit, offset).all<LibraryAssetRow>();
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
    async insertGenerated(a) {
      // No url column: migration 0007 dropped the stored URL columns — every
      // URL is derived from the row (asset-urls.ts); non-locally_cached rows
      // serve source_url directly.
      await db.prepare(
        `INSERT INTO assets (id, prompt, source, model_used, width, height, mime, source_url, locally_cached, price_usd, provider, created_by, collection_id)
         VALUES (?, ?, 'byok', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).bind(a.id, a.prompt, a.modelUsed, a.width, a.height, a.mime, a.sourceUrl, a.priceUsd, a.provider, a.createdBy, a.collectionId).run();
    },
    async listByCollection({ collectionId, limit, offset }) {
      const { results } = await db.prepare(
        `SELECT ${ASSET_COLS}, created_at, serve_count FROM live_assets WHERE collection_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).bind(collectionId, limit, offset).all<CollectionImageRow>();
      return results ?? [];
    },
    async getCollectionMember(assetId, collectionId) {
      const row = await db.prepare(
        `SELECT ${ASSET_COLS} FROM live_assets WHERE id = ? AND collection_id = ?`
      ).bind(assetId, collectionId).first<AssetRow>();
      return row ?? null;
    },
    // Tombstones write to the base table: live_assets is a view and the
    // dead_at IS NULL guard makes both calls idempotent.
    async tombstoneAsset(id) {
      await db.prepare("UPDATE assets SET dead_at = datetime('now') WHERE id = ? AND dead_at IS NULL").bind(id).run();
    },
    async tombstoneByCollection(collectionId) {
      const { results } = await db.prepare(
        "UPDATE assets SET dead_at = datetime('now') WHERE collection_id = ? AND dead_at IS NULL RETURNING id"
      ).bind(collectionId).all<{ id: string }>();
      return (results ?? []).map((r) => r.id);
    },
    async bumpServeCount(id) {
      await db.prepare("UPDATE assets SET serve_count = serve_count + 1 WHERE id = ?").bind(id).run();
    },
    async previewsByCollections(collectionIds, per) {
      if (!collectionIds.length) return [];
      const ph = collectionIds.map(() => "?").join(", ");
      const { results } = await db.prepare(
        `SELECT collection_id, id, prompt, source_url, locally_cached FROM (
           SELECT a.collection_id, a.id, a.prompt, a.source_url, a.locally_cached,
                  ROW_NUMBER() OVER (PARTITION BY a.collection_id ORDER BY a.created_at DESC, a.id DESC) AS rn
           FROM live_assets a WHERE a.collection_id IN (${ph})
         ) WHERE rn <= ?`
      ).bind(...collectionIds, per).all<CollectionPreviewRow>();
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
    async totalGenerated(userId) {
      const row = await db.prepare(
        "SELECT COALESCE(SUM(count), 0) AS n FROM byok_usage WHERE user_id = ?"
      ).bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
  };

  const collections: CollectionStore = {
    async create({ id, ownerUserId, name, themePrompt }) {
      await db.prepare(
        "INSERT INTO collections (id, owner_user_id, name, theme_prompt) VALUES (?, ?, ?, ?)"
      ).bind(id, ownerUserId, name, themePrompt).run();
    },
    async get(id) {
      const row = await db.prepare(
        "SELECT id, owner_user_id, name, theme_prompt, created_at, updated_at FROM collections WHERE id = ?"
      ).bind(id).first<CollectionRow>();
      return row ?? null;
    },
    async listByOwner(userId) {
      // Aggregates come from live_assets so tombstoned images drop out of both counts.
      const { results } = await db.prepare(
        `SELECT c.id, c.owner_user_id, c.name, c.theme_prompt, c.created_at, c.updated_at, c.search_count,
                COUNT(a.id) AS image_count, COALESCE(SUM(a.serve_count), 0) AS total_serves
         FROM collections c LEFT JOIN live_assets a ON a.collection_id = c.id
         WHERE c.owner_user_id = ?
         GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`
      ).bind(userId).all<CollectionSummary>();
      return results ?? [];
    },
    async countByOwner(userId) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM collections WHERE owner_user_id = ?").bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
    async patch(id, f) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const args: unknown[] = [];
      if (f.name != null) { sets.push("name = ?"); args.push(f.name); }
      if (f.themePrompt != null) { sets.push("theme_prompt = ?"); args.push(f.themePrompt); }
      await db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
    },
    async delete(id) {
      await db.prepare("DELETE FROM collections WHERE id = ?").bind(id).run();
    },
    async browse({ q, limit, offset }) {
      // Same live_assets aggregates as listByOwner, unscoped; ESCAPE guards
      // user-typed % and _ in the name filter (parity with searchAssets).
      const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
      const { results } = await db.prepare(
        `SELECT c.id, c.owner_user_id, c.name, c.theme_prompt, c.created_at, c.updated_at, c.search_count,
                COUNT(a.id) AS image_count, COALESCE(SUM(a.serve_count), 0) AS total_serves
         FROM collections c LEFT JOIN live_assets a ON a.collection_id = c.id
         ${like ? "WHERE c.name LIKE ? ESCAPE '\\'" : ""}
         GROUP BY c.id ORDER BY total_serves DESC, c.created_at DESC, c.id DESC
         LIMIT ? OFFSET ?`
      ).bind(...(like ? [like] : []), limit, offset).all<CollectionSummary>();
      return results ?? [];
    },
    async bumpSearchCount(id) {
      await db.prepare("UPDATE collections SET search_count = search_count + 1 WHERE id = ?").bind(id).run();
    },
  };

  const GEN_COLS =
    "id, user_id, collection_id, prompt, provider, provider_job_id, status, asset_id, error, month, attempts, claimed_at, created_at, updated_at";
  const generations: GenerationStore = {
    async create(g) {
      await db.prepare(
        "INSERT INTO generations (id, user_id, collection_id, prompt, provider, month) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(g.id, g.userId, g.collectionId, g.prompt, g.provider, g.month).run();
    },
    async get(id) {
      const row = await db.prepare(`SELECT ${GEN_COLS} FROM generations WHERE id = ?`).bind(id).first<GenerationRow>();
      return row ?? null;
    },
    async setProviderJob(id, providerJobId) {
      await db.prepare(
        "UPDATE generations SET provider_job_id = ?, status = 'generating', updated_at = datetime('now') WHERE id = ? AND status = 'queued'"
      ).bind(providerJobId, id).run();
    },
    // Single guarded UPDATE = the atomic claim (same shape as byok.reserve):
    // two concurrent polls cannot both drive the provider. Stale (>60s) claims
    // are reclaimable so a crashed driver never wedges the job.
    async claim(id) {
      const row = await db.prepare(
        `UPDATE generations SET claimed_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
         WHERE id = ? AND status IN ('queued','generating')
           AND (claimed_at IS NULL OR claimed_at < datetime('now','-60 seconds'))
         RETURNING id`
      ).bind(id).first();
      return !!row;
    },
    async release(id) {
      await db.prepare("UPDATE generations SET claimed_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(id).run();
    },
    async succeed(id, assetId) {
      const row = await db.prepare(
        "UPDATE generations SET status = 'succeeded', asset_id = ?, claimed_at = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('queued','generating') RETURNING id"
      ).bind(assetId, id).first();
      return !!row;
    },
    async fail(id, error) {
      const row = await db.prepare(
        "UPDATE generations SET status = 'failed', error = ?, claimed_at = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('queued','generating') RETURNING id"
      ).bind(error, id).first();
      return !!row;
    },
    async listStale(olderThanSec, limit) {
      const { results } = await db.prepare(
        `SELECT ${GEN_COLS} FROM generations WHERE status IN ('queued','generating') AND updated_at < datetime('now', ?) ORDER BY updated_at ASC LIMIT ?`
      ).bind(`-${olderThanSec} seconds`, limit).all<GenerationRow>();
      return results ?? [];
    },
    async countOpenByUser(userId) {
      const row = await db.prepare(
        "SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ('queued','generating')"
      ).bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
    async listPendingByCollection(collectionId, userId, limit) {
      const { results } = await db.prepare(
        `SELECT ${GEN_COLS} FROM generations WHERE collection_id = ? AND user_id = ? AND status IN ('queued','generating') ORDER BY created_at DESC LIMIT ?`
      ).bind(collectionId, userId, limit).all<GenerationRow>();
      return results ?? [];
    },
  };

  return { assets, queries, keys, users, sessions, loginTokens, byok, collections, generations };
}
