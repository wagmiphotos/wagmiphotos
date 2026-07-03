FROM python:3.11-slim
WORKDIR /app

# CPU-only torch first (small wheel from the pytorch index), then the package.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY projects/embedder ./embedder
RUN pip install --no-cache-dir "./embedder[model]"

# Bake the ViT-L/14 weights into the image: immutable, fast start, no runtime egress.
RUN python -c "from sharedcache.embedder.model import OpenClipEncoder; OpenClipEncoder()"

EXPOSE 8000
CMD ["python", "-m", "sharedcache.embedder"]
