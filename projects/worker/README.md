# Cloudflare Worker — Wagmi Photos API

This Cloudflare Worker powers the wagmi.photos API backend.

## Embeddings

The Worker embeds query prompts with Workers AI `@cf/baai/bge-base-en-v1.5` (768-dimensional text-to-text embedding), queries the `wagmiphotos-bge` Vectorize index, and returns similar images from the library.

There is no external embedding endpoint — all embeddings are computed in-worker via Workers AI.

### Similarity Floor Configuration

The similarity floors are pinned in the repo-root `contract.json` and mirrored
as code defaults in `src/floor.ts` (`FLOOR_SIM_MAX=0.84`, `FLOOR_SIM_MIN=0.75`,
`LIBRARY_FLOOR_SIM=0.60`). Env vars of the same names override the defaults
(via `numEnv`) — that's for local experiments only. Never commit them to
`wrangler.toml` `[vars]`: a committed var silently overrides the contract in
every deploy, and `test/contract.test.ts` fails if one drifts.
