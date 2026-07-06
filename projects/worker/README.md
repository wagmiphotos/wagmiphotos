# Cloudflare Worker — Wagmi Photos API

This Cloudflare Worker powers the wagmi.photos API backend.

## Embeddings

The Worker embeds query prompts with Workers AI `@cf/baai/bge-base-en-v1.5` (768-dimensional text-to-text embedding), queries the `wagmiphotos-bge` Vectorize index, and returns similar images from the library.

There is no external embedding endpoint — all embeddings are computed in-worker via Workers AI.

### Similarity Floor Configuration

The similarity floor values are BGE-tuned placeholders and can be adjusted per deployment via environment variables:

- `FLOOR_SIM_MAX`: Maximum similarity threshold (default: 0.90)
- `FLOOR_SIM_MIN`: Minimum similarity threshold (default: 0.72)
