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
    },
    queries: { recordQuery: async (i) => { recorded.push(i); return i.generate; } },
    keys: {
      getKeyOwner: async (h) => (keyOwners.get(h) ?? null),
      addKey: async (h, u) => { keyOwners.set(h, u); },
      listByUser: async () => [],
      deleteKey: async (u, id) => { if (keyOwners.get(id) === u) keyOwners.delete(id); },
    },
    rateLimiter: { limit: async () => true },
    users: { upsertByEmail: async (id, email) => ({ id, email }), getById: async () => ({ id: "usr_1", email: "a@b.co", created_at: "x", last_login: null }) },
    sessions: { create: async () => {}, resolve: async () => null, touch: async () => {}, delete: async () => {}, purgeExpired: async () => {} },
    loginTokens: { create: async (_hash: string, _email: string, _nonceHash: string) => {}, consume: async (_hash: string, _nonceHash: string) => null, purgeExpired: async () => {} },
    email: { sendMagicLink: async () => {} },
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
