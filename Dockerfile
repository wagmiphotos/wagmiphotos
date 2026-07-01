FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
COPY src ./src
COPY scripts ./scripts
RUN uv sync --frozen --no-dev
ENTRYPOINT ["uv", "run", "python", "-m", "sharedcache.backfill"]
