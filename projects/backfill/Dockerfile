FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
COPY projects/common ./projects/common
COPY projects/generation ./projects/generation
COPY projects/backfill ./projects/backfill
RUN uv sync --frozen --no-dev --package wagmiphotos-backfill --extra model
# Drop root: run as an unprivileged user that owns the synced venv + app dir.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser
ENTRYPOINT ["uv", "run", "--no-sync", "--package", "wagmiphotos-backfill", "python", "-m", "wagmiphotos.backfill"]
