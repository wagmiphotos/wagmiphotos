import type { Services, AssetRow, LibraryAssetRow, Match, ByokRow, CollectionRow } from "../src/types";

export function fakeServices(overrides: Partial<Services> = {}): Services {
  const assets = new Map<string, AssetRow>();
  const libraryRows: LibraryAssetRow[] = [];
  const searchCalls: { q: string; limit: number; offset: number }[] = [];
  const recorded: any[] = [];
  const keyOwners = new Map<string, string>();
  const matches: Match[] = [];
  const upserted: { id: string; vector: number[] }[] = [];
  const nsMatches: { id: string; score: number; ns: string }[] = [];
  const nsUpserted: { id: string; vector: number[]; namespace: string }[] = [];
  const vectorDeletes: string[] = [];
  const generatedInserts: any[] = [];
  const byokRows = new Map<string, ByokRow>();
  const byokUsage = new Map<string, { count: number; est_spend_usd: number }>();
  const collectionRows = new Map<string, CollectionRow>();
  const serveCounts = new Map<string, number>();
  const tombstoned: string[] = [];
  const base: Services = {
    embedder: { textEmbed: async () => [0.1, 0.2, 0.3] },
    vectorize: {
      query: async () => matches,
      upsert: async (id: string, vector: number[]) => { upserted.push({ id, vector }); },
      queryNamespace: async (_v: number[], namespace: string) => nsMatches.filter((m) => m.ns === namespace).map((m) => ({ id: m.id, score: m.score })),
      upsertNamespace: async (id: string, vector: number[], namespace: string) => { nsUpserted.push({ id, vector, namespace }); },
      deleteByIds: async (ids: string[]) => { vectorDeletes.push(...ids); },
    },
    assets: {
      getAsset: async (id) => assets.get(id) ?? null,
      searchAssets: async (i) => { searchCalls.push(i); return libraryRows.slice(i.offset, i.offset + i.limit); },
      getAssetsByIds: async (ids) => ids.flatMap((id) => {
        const r = assets.get(id);
        return r ? [r as LibraryAssetRow] : [];
      }),
      insertGenerated: async (a) => {
        generatedInserts.push(a);
        // collection_id + libraryRows keep the row visible to the collection
        // fakes (getCollectionMember/tombstoneByCollection/listByCollection).
        const row = {
          id: a.id, prompt: a.prompt, source: "byok", source_id: null, model_used: a.modelUsed,
          width: a.width, height: a.height, mime: a.mime, source_url: a.sourceUrl, locally_cached: 0,
          collection_id: a.collectionId ?? null, created_at: "x",
        };
        assets.set(a.id, row);
        libraryRows.push(row);
      },
      listByCollection: async ({ collectionId, limit, offset }) =>
        libraryRows.filter((r: any) => r.collection_id === collectionId).slice(offset, offset + limit).map((r: any) => ({ ...r, serve_count: serveCounts.get(r.id) ?? 0 })),
      getCollectionMember: async (assetId, collectionId) => {
        const r: any = assets.get(assetId);
        return r && r.collection_id === collectionId && !tombstoned.includes(assetId) ? r : null;
      },
      tombstoneAsset: async (id) => { tombstoned.push(id); assets.delete(id); },
      tombstoneByCollection: async (collectionId) => {
        const ids = [...assets.values()].filter((r: any) => r.collection_id === collectionId).map((r) => r.id);
        for (const id of ids) { tombstoned.push(id); assets.delete(id); }
        return ids;
      },
      bumpServeCount: async (id) => { serveCounts.set(id, (serveCounts.get(id) ?? 0) + 1); },
    },
    queries: { recordQuery: async (i) => { recorded.push(i); return i.generate; } },
    keys: {
      getKeyOwner: async (h) => (keyOwners.get(h) ?? null),
      addKey: async (h, u) => { keyOwners.set(h, u); },
      listByUser: async () => [],
      deleteKey: async (u, id) => { if (keyOwners.get(id) === u) keyOwners.delete(id); },
    },
    rateLimiter: { limit: async () => true },
    rateLimiterPaid: { limit: async () => true },
    users: {
      upsertByEmail: async (id, email) => ({ id, email }),
      getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null, tos_version: null, tos_accepted_at: null, stripe_customer_id: null, stripe_subscription_id: null, plan_status: null, plan_current_period_end: null }),
      acceptTos: async () => {},
      getByStripeCustomerId: async () => null,
      setStripeCustomer: async () => {},
      setSubscriptionByCustomer: async () => {},
    },
    sessions: { create: async () => {}, resolve: async () => null, touch: async () => {}, delete: async () => {}, purgeExpired: async () => {} },
    loginTokens: { create: async (_hash: string, _email: string, _nonceHash: string) => {}, consume: async (_hash: string, _nonceHash: string) => null, purgeExpired: async () => {} },
    email: { sendMagicLink: async () => {} },
    stripe: {
      createCustomer: async () => ({ id: "cus_fake" }),
      createCheckoutSession: async () => ({ url: "https://checkout.stripe/fake" }),
      createPortalSession: async () => ({ url: "https://portal.stripe/fake" }),
    },
    byok: {
      get: async (u) => byokRows.get(u) ?? null,
      put: async (i) => { byokRows.set(i.userId, { user_id: i.userId, provider: i.provider as ByokRow["provider"], key_ciphertext: i.keyCiphertext, key_last4: i.keyLast4, enabled: i.enabled ? 1 : 0, monthly_cap: i.monthlyCap, last_error: null, created_at: "x", updated_at: "x" }); },
      patch: async (u, f) => { const r = byokRows.get(u); if (!r) return; if (f.enabled != null) r.enabled = f.enabled ? 1 : 0; if (f.monthlyCap != null) r.monthly_cap = f.monthlyCap; },
      delete: async (u) => { byokRows.delete(u); },
      disable: async (u, err) => { const r = byokRows.get(u); if (r) { r.enabled = 0; r.last_error = err; } },
      getUsage: async (u, m) => ({ ...(byokUsage.get(`${u}:${m}`) ?? { count: 0, est_spend_usd: 0 }) }),
      reserve: async (u, m, cap) => { const k = `${u}:${m}`; const cur = byokUsage.get(k) ?? { count: 0, est_spend_usd: 0 }; if (cur.count >= cap) return false; cur.count += 1; byokUsage.set(k, cur); return true; },
      refund: async (u, m) => { const cur = byokUsage.get(`${u}:${m}`); if (cur) cur.count = Math.max(0, cur.count - 1); },
      addSpend: async (u, m, usd) => { const k = `${u}:${m}`; const cur = byokUsage.get(k) ?? { count: 0, est_spend_usd: 0 }; cur.est_spend_usd += usd; byokUsage.set(k, cur); },
      totalGenerated: async (u) => {
        let n = 0;
        for (const [k, v] of byokUsage) if (k.startsWith(`${u}:`)) n += v.count;
        return n;
      },
    },
    collections: {
      create: async ({ id, ownerUserId, name, themePrompt }) => {
        collectionRows.set(id, { id, owner_user_id: ownerUserId, name, theme_prompt: themePrompt, created_at: "x", updated_at: "x" });
      },
      get: async (id) => collectionRows.get(id) ?? null,
      listByOwner: async (userId) => [...collectionRows.values()].filter((c) => c.owner_user_id === userId).map((c) => ({ ...c, image_count: 0, total_serves: 0 })),
      countByOwner: async (userId) => [...collectionRows.values()].filter((c) => c.owner_user_id === userId).length,
      patch: async (id, f) => { const c = collectionRows.get(id); if (!c) return; if (f.name != null) c.name = f.name; if (f.themePrompt != null) c.theme_prompt = f.themePrompt; },
      delete: async (id) => { collectionRows.delete(id); },
    },
  };
  // expose internals for assertions
  (base as any)._assets = assets;
  (base as any)._libraryRows = libraryRows;
  (base as any)._searchCalls = searchCalls;
  (base as any)._recorded = recorded;
  (base as any)._matches = matches;
  (base as any)._upserted = upserted;
  (base as any)._nsMatches = nsMatches;
  (base as any)._nsUpserted = nsUpserted;
  (base as any)._vectorDeletes = vectorDeletes;
  (base as any)._generatedInserts = generatedInserts;
  (base as any)._keyOwners = keyOwners;
  (base as any)._byokRows = byokRows;
  (base as any)._byokUsage = byokUsage;
  (base as any)._collectionRows = collectionRows;
  (base as any)._serveCounts = serveCounts;
  (base as any)._tombstoned = tombstoned;
  return { ...base, ...overrides };
}
