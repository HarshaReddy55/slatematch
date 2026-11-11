# SlateMatch - multi-stage build: the Rust kernel is compiled in stage 1
# and the binary is copied into the Python runtime in stage 2, so the
# deployed service runs the real Rust kernel (SLATEMATCH_KERNEL_BIN),
# not the Python fallback. rust_bridge.py calls it over stdio.
FROM rust:1.82-slim AS rust-builder
WORKDIR /build
COPY rust-kernel/Cargo.toml rust-kernel/Cargo.lock* ./
COPY rust-kernel/src ./src
RUN cargo build --release

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    SLATEMATCH_DATA_DIR=/app/data \
    SLATEMATCH_KERNEL_BIN=/app/bin/slatematch-kernel
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install -r backend/requirements.txt
COPY backend/app ./backend/app
COPY backend/tests ./backend/tests
COPY frontend ./frontend
COPY docs ./docs
COPY --from=rust-builder /build/target/release/slatematch-kernel /app/bin/slatematch-kernel
RUN mkdir -p /app/data && useradd -m slatematch && chown -R slatematch /app
USER slatematch
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ready')" || exit 1
CMD ["sh", "-c", "python -m uvicorn api:app --app-dir backend/app --host 0.0.0.0 --port ${PORT:-8080}"]
