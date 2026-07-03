FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
COPY projects/common ./projects/common
COPY projects/generation ./projects/generation
COPY projects/backfill ./projects/backfill
COPY projects/embedder ./projects/embedder
RUN uv sync --frozen --no-dev --package sharedcache-backfill
ENTRYPOINT ["uv", "run", "--package", "sharedcache-backfill", "python", "-m", "sharedcache.backfill"]
