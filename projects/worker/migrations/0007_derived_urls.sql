-- Asset URLs become derived: {ASSET_BASE_URL}/{asset_paths[size]} when
-- locally_cached=1, else source_url (contract.json: asset_paths). Dropping the
-- stored copies saves ~300B/row (~3.7GB at PD12M scale). No production data
-- exists; local data is re-seedable.
ALTER TABLE assets DROP COLUMN thumb_url;
ALTER TABLE assets DROP COLUMN medium_url;
ALTER TABLE assets DROP COLUMN url;
ALTER TABLE assets DROP COLUMN manifest_url;
