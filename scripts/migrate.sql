CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt TEXT NOT NULL,
    url TEXT NOT NULL,
    thumb_url TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    mime TEXT NOT NULL,
    manifest_url TEXT,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_embedding
    ON assets USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS savings_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key TEXT,
    asset_id UUID REFERENCES assets(id),
    cost_saved_usd NUMERIC(10,5) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
