FROM python:3.11-slim
WORKDIR /app

# CPU-only torch first (small wheel from the pytorch index), then the package.
RUN pip install --no-cache-dir torch==2.12.1 torchvision==0.27.1 --index-url https://download.pytorch.org/whl/cpu
COPY projects/embedder ./embedder
RUN pip install --no-cache-dir "./embedder[model]"

# Drop root: create the runtime user, then bake weights AS that user so the
# open_clip cache lands in a home dir it can read at runtime.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

# Bake the ViT-L/14 weights into the image: immutable, fast start, no runtime egress.
RUN python -c "from sharedcache.embedder.model import OpenClipEncoder; OpenClipEncoder()"

EXPOSE 8000
CMD ["python", "-m", "sharedcache.embedder"]
