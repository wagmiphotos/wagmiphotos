import contract from "../../../contract.json";

export interface AssetUrlInput { id: string; source_url: string | null; locally_cached: number; }
export interface DerivedUrls { url: string; thumb_url: string | null; medium_url: string | null; original_url: string | null; }

const fill = (tpl: string, id: string) => tpl.replace("{id}", id);

// URLs are pure functions of the row (spec Part 3). locally_cached rows live
// at the contract-pinned B2 keys under ASSET_BASE_URL; everything else serves
// its origin. An unset base on a cached row is a misconfiguration — degrade
// to the origin rather than emitting broken links.
export function assetUrls(a: AssetUrlInput, baseUrl: string | undefined): DerivedUrls {
  const original_url = a.source_url ?? null;
  if (!a.locally_cached || !baseUrl) {
    if (a.locally_cached && !baseUrl) console.warn("ASSET_BASE_URL unset; serving source_url for", a.id);
    return { url: a.source_url ?? "", thumb_url: null, medium_url: null, original_url };
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/${fill(contract.asset_paths.large, a.id)}`,
    thumb_url: `${base}/${fill(contract.asset_paths.thumb, a.id)}`,
    medium_url: `${base}/${fill(contract.asset_paths.medium, a.id)}`,
    original_url,
  };
}
