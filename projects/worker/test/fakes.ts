import type { Services, AssetRow, LibraryAssetRow, Match } from "../src/types";

export function fakeServices(overrides: Partial<Services> = {}): Services {
  const assets = new Map<string, AssetRow>();
  const libraryRows: LibraryAssetRow[] = [];
  const searchCalls: { q: string; limit: number; offset: number }[] = [];
  const recorded: any[] = [];
  const keyOwners = new Map<string, string>();
  const matches: Match[] = [];
  const base: Services = {
    embedder: { textEmbed: async () => [0.1, 0.2, 0.3] },
    vectorize: { query: async () => matches },
    assets: {
      getAsset: async (id) => assets.get(id) ?? null,
      searchAssets: async (i) => { searchCalls.push(i); return libraryRows.slice(i.offset, i.offset + i.limit); },
      getAssetsByIds: async (ids) => ids.flatMap((id) => {
        const r = assets.get(id);
        return r ? [r as LibraryAssetRow] : [];
      }),
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
  };
  // expose internals for assertions
  (base as any)._assets = assets;
  (base as any)._libraryRows = libraryRows;
  (base as any)._searchCalls = searchCalls;
  (base as any)._recorded = recorded;
  (base as any)._matches = matches;
  (base as any)._keyOwners = keyOwners;
  return { ...base, ...overrides };
}
