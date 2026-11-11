# Deployment Guide

SlateMatch product pack, document 5 of 8. Previous: Implementation Guide. Next: AWS Deployment Runbook.

## 5.1 Local Workstation Deployment

### Step 1: Build the Rust Native Kernel
```bash
cd rust-kernel
cargo build --release
cd ..
```
This compiles the kernel binary at `rust-kernel/target/release/slatematch-kernel`; point the `SLATEMATCH_KERNEL_BIN` environment variable at it. (The Docker build below compiles and places it automatically.)

### Step 2: Install Pinned Python Dependencies and Launch
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn api:app --app-dir backend/app --host 0.0.0.0 --port 8080
```
Navigate to `http://localhost:8080` to open the 14-page workspace.

## 5.2 Multi-Stage Docker Build
The root `Dockerfile` performs a reproducible two-stage build:
1. **Stage 1 (`rust:1.82-slim`):** Compiles `rust-kernel` in `--release` mode to produce the `slatematch-kernel` binary.
2. **Stage 2 (`python:3.12-slim`):** Installs pinned dependencies from `backend/requirements.txt`, copies the compiled `slatematch-kernel` binary, `backend/app`, `frontend`, and `docs`, runs as a non-root user (`slatematch`), and starts `uvicorn` on port `8080`. The image also carries `backend/tests` and the `tesseract-ocr` system package (required for image OCR), and its HEALTHCHECK probes `/ready` every 30 seconds.

```bash
docker build -t slatematch .
docker run -d -p 8080:8080 --name slatematch slatematch
```

## 5.3 Runtime Configuration Variables

| Environment Variable | Default | Purpose |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Unset | Optional Google Gemini API key for live LLM remittance parsing and briefing generation. Falls back cleanly to deterministic parsing when unset or rate-limited. |
| `SLATEMATCH_DATA_DIR` | `backend/data` | Filesystem path for the per-tenant and per-session SQLite `WAL` databases. The ECS deployment sets it to `/tmp/slatematch-data`. |
| `GEMINI_MODEL` | code default | The Gemini model for live parsing. The production ECS environment sets `gemini-3.5-flash-lite` (the code-default thinking model exceeded the platform ingress time limit). |
| `SLATEMATCH_KERNEL_BIN` | Unset | Path to the compiled Rust kernel binary; unset means the MILP decides every payment. |
| `SLATEMATCH_RATE_LIMIT_PER_MIN` | `300` | Per-API-key request ceiling, per minute. |
| `SLATEMATCH_BOOTSTRAP_KEY` | Unset (Open Demo Mode) | Optional master key to enforce API key authentication on administrative routes. |
| `SLATEMATCH_SMTP_HOST`, `SLATEMATCH_SMTP_USER`, `SLATEMATCH_SMTP_PASSWORD`, `SLATEMATCH_MAIL_FROM` | Unset | Optional SMTP configuration for live email dispatch. Until set, sends record as `recorded_not_sent`. The password is automatically redacted in `/api/v1/diagnostics`. |
| `SLATEMATCH_SMTP_PORT` | `587` | SMTP port for live dispatch. |
| `SLATEMATCH_SMTP_TLS` | On | TLS for the SMTP connection; only `0` disables it. |
| `GEMINI_TIMEOUT_S` | `40` | Per-call Gemini timeout in seconds, held safely below the platform ingress ceiling. |
| `SLATEMATCH_DOCS_DIR` | Unset | Overrides the directory served by `/api/v1/docs`. |
| `PORT` | `8080` | The port the container binds; platforms that assign a port set this. |

---

Version 3.1 | 3 Nov 2026 | Owner: C. Harsha Vardhana Reddy
