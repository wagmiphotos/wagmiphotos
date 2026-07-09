import type { Services, AssetRow, LibraryAssetRow, Match, ByokRow } from "../src/types";

export function fakeServices(overrides: Partial<Services> = {}): Services {
  const assets = new Map<string, AssetRow>();
  const libraryRows: LibraryAssetRow[] = [];
  const searchCalls: { q: string; limit: number; offset: number }[] = [];
  const recorded: any[] = [];
  const keyOwners = new Map<string, string>();
  const matches: Match[] = [];
  const upserted: { id: string; vector: number[] }[] = [];
  const generatedInserts: any[] = [];
  const byokRows = new Map<string, ByokRow>();
  const byokUsage = new Map<string, { count: number; est_spend_usd: number }>();
  const base: Services = {
    embedder: { textEmbed: async () => [0.1, 0.2, 0.3] },
    vectorize: {
      query: async () => matches,
      upsert: async (id: string, vector: number[]) => { upserted.push({ id, vector }); },
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
        assets.set(a.id, {
          id: a.id, prompt: a.prompt, source: "byok", source_id: null, model_used: a.modelUsed,
          width: a.width, height: a.height, mime: a.mime, source_url: a.sourceUrl, locally_cached: 0,
        });
      },
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
    },
  };
  // expose internals for assertions
  (base as any)._assets = assets;
  (base as any)._libraryRows = libraryRows;
  (base as any)._searchCalls = searchCalls;
  (base as any)._recorded = recorded;
  (base as any)._matches = matches;
  (base as any)._upserted = upserted;
  (base as any)._generatedInserts = generatedInserts;
  (base as any)._keyOwners = keyOwners;
  (base as any)._byokRows = byokRows;
  (base as any)._byokUsage = byokUsage;
  return { ...base, ...overrides };
}
