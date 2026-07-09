# cdn.wagmi.photos + open-license band — design (2026-07-09)

## 1. Asset hostname: `cdn.wagmi.photos` with clean `/assets/` paths

Decision: the public asset origin is **`https://cdn.wagmi.photos/assets/{id}/<size>.webp`**.
The previously documented `images.wagmi.photos` never actually existed in DNS
(never noticed because the backfill box has not run, so no B2-hosted URL was
ever served). No customers, no legacy URLs — clean cut, no alias needed.

Edge config (done in the Cloudflare dashboard, verified live 2026-07-09):
- DNS: `cdn` proxied record → B2 friendly-URL host.
- Transform Rule (URL Rewrite): `http.host eq "cdn.wagmi.photos" and
  starts_with(http.request.uri.path, "/assets/")` → dynamic path
  `concat("/file/wagmi-photos-library", http.request.uri.path)`. This hides
  the storage vendor and bucket from public URLs, so a future bucket/provider
  move (or `cdn.wagmi.photos/video/…`) never changes them.
- Cache rule covers `cdn.wagmi.photos`.
- Verified: `GET https://cdn.wagmi.photos/assets/probe/thumb.webp` returns
  B2's `not_found` JSON (request reached the bucket via the rewrite).

Repo changes:
- `projects/worker/wrangler.toml`: `ASSET_BASE_URL = "https://cdn.wagmi.photos"`
  (contract `asset_paths` already start with `assets/…`, so `assetUrls()`
  composes the clean URL with no code change).
- `deploy/gmi/.env` (local, gitignored): `B2_PUBLIC_URL_BASE=https://cdn.wagmi.photos`
  — must stay equal to `ASSET_BASE_URL`; update any `.env.example` comments
  that reference the old host.
- Docs: `DEPLOY.md` (mention hostname + the Transform Rule as part of infra)
  and `HANDOFF.md`'s "Assets CDN path" bullet.
- Homepage examples (3 sites: how-it-works flow bubble, API-section response
  card, docs response example) become the real shape:
  `https://cdn.wagmi.photos/assets/pd12m-8f31…/image.webp`.
- NOT changed: the B2 bucket name (cannot be renamed in place; hidden from
  URLs now anyway), `byok.wagmi.photos` (separate R2 origin), `contract.json`
  `asset_paths` (bucket keys, not URLs).

## 2. CTA band → open-license positioning

Replace the band copy ("Stop paying for the same image twice. / Plug in
wagmi.photos and let every generation pull its weight.") with (approved
draft), keeping the band styling and both buttons:

- H2: `Openly licensed. Close enough, on purpose.`
- Body: `Every image here is openly licensed — the seed pool is public-domain
  PD12M, and generated images are shared under the same permissive terms.
  Reach for wagmi.photos when you don't need a pixel-exact, one-off render:
  you need a good image now, with a license you don't have to think about.
  Need guaranteed commercial use? That's the one upgrade.`
- Buttons unchanged: `Launch playground →` / `View pricing`.

Claims stay consistent with the existing FAQ ("permissive open license"),
pricing (paid adds the commercial-use license), and Terms copy.

## Verification

Suite + tsc unchanged (HTML/config-only for the worker); SPA script parses;
deploy; then live checks: homepage shows the new band + cdn URLs, and once a
first asset is rehosted the real image must serve at
`https://cdn.wagmi.photos/assets/{id}/thumb.webp` (until the backfill box
runs, the B2 404-shape probe stands in as the wiring proof).
