import { describe, it, expect } from "vitest";
import { assetUrls } from "../src/asset-urls";
import contract from "../../../contract.json";

const BASE = "https://cdn.example.com";

describe("assetUrls", () => {
  it("derives all sizes from the contract templates when locally cached", () => {
    const u = assetUrls({ id: "abc", source_url: null, locally_cached: 1 }, BASE);
    expect(u).toEqual({
      url: `${BASE}/assets/abc/image.webp`,
      thumb_url: `${BASE}/assets/abc/thumb.webp`,
      medium_url: `${BASE}/assets/abc/medium.webp`,
    });
    expect(u.url.endsWith(contract.asset_paths.large.replace("{id}", "abc"))).toBe(true);
  });
  it("serves source_url with null sizes when not locally cached", () => {
    expect(assetUrls({ id: "x", source_url: "https://o.example/p.png", locally_cached: 0 }, BASE))
      .toEqual({ url: "https://o.example/p.png", thumb_url: null, medium_url: null });
  });
  it("falls back to source_url when the base is unset (misconfiguration)", () => {
    expect(assetUrls({ id: "x", source_url: "https://o.example/p.png", locally_cached: 1 }, undefined).url)
      .toBe("https://o.example/p.png");
  });
  it("tolerates a trailing slash on the base", () => {
    expect(assetUrls({ id: "a", source_url: null, locally_cached: 1 }, BASE + "/").url)
      .toBe(`${BASE}/assets/a/image.webp`);
  });
});
