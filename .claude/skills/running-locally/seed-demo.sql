-- Demo library seed for local `wrangler dev` (http://127.0.0.1:8787).
-- Idempotent: safe to re-run. source_url points at the Worker's own bundled
-- static assets (public/assets/*.webp) so the library renders fully offline —
-- no B2, no generation. Absolute :8787 URLs keep the server-side download
-- proxy (/v1/library/:id/download) working; change the port here if you serve
-- on a different one. locally_cached=0 so URLs are served as-is (derived,
-- not rehosted); the SPA's thumb_url || medium_url || url fallback renders
-- the grid straight from url = source_url.
INSERT OR REPLACE INTO assets
  (id, prompt, source, source_url, model_used, width, height, mime, locally_cached)
VALUES
  ('demo-1', 'A flamingo standing in shallow water at sunset', 'pd12m',
   'http://127.0.0.1:8787/assets/match-flamingo.webp', NULL, 1024, 1024, 'image/webp', 0),
  ('demo-2', 'A cat and a dog sitting together on a couch', 'pd12m',
   'http://127.0.0.1:8787/assets/match-cat-dog.webp', NULL, 1024, 1024, 'image/webp', 0),
  ('demo-3', 'Grandpa giving an enthusiastic thumbs up', 'pd12m',
   'http://127.0.0.1:8787/assets/grandpa-thumbs-up.webp', NULL, 1024, 1024, 'image/webp', 0),
  ('demo-4', 'Two hands clasped in a firm handshake', 'pd12m',
   'http://127.0.0.1:8787/assets/handshake.webp', NULL, 1024, 1024, 'image/webp', 0);
