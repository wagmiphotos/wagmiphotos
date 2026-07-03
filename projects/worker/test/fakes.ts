import type { Services, AssetRow, LibraryAssetRow, Match } from "../src/types";

export function fakeServices(overrides: Partial<Services> = {}): Services {
  const assets = new Map<string, AssetRow>();
  const libraryRows: LibraryAssetRow[] = [];
  const searchCalls: { q: string; limit: number; offset: number }[] = [];
  const recorded: any[] = [];
  const keyHashes = new Set<string>();
  const matches: Match[] = [];
  const base: Services = {
    clip: { textEmbed: async () => [0.1, 0.2, 0.3] },
    vectorize: { query: async () => matches },
    assets: {
      getAsset: async (id) => assets.get(id) ?? null,
      searchAssets: async (i) => { searchCalls.push(i); return libraryRows.slice(i.offset, i.offset + i.limit); },
    },
    queries: { recordQuery: async (i) => { recorded.push(i); return i.generate; } },
    keys: { verifyKey: async (h) => keyHashes.has(h), addKey: async (h) => { keyHashes.add(h); } },
    rateLimiter: { limit: async () => true },
  };
  // expose internals for assertions
  (base as any)._assets = assets;
  (base as any)._libraryRows = libraryRows;
  (base as any)._searchCalls = searchCalls;
  (base as any)._recorded = recorded;
  (base as any)._matches = matches;
  (base as any)._keyHashes = keyHashes;
  return { ...base, ...overrides };
}
