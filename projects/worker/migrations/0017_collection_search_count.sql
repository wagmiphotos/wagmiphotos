-- Public collections browse (spec: 2026-07-10 public collections tab).
-- search_count: how many collection-scoped reads ran against the collection
-- (GET /v1/library?collection= and scoped POST /v1/images/generations).
-- Owner- and browse-facing stat; no view depends on collections, so a plain
-- ALTER suffices.
ALTER TABLE collections ADD COLUMN search_count INTEGER NOT NULL DEFAULT 0;
