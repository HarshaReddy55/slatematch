# AWS Deployment Runbook

SlateMatch product pack, document 6 of 8. Previous: Deployment Guide. Next: Go-To-Market Plan.

## 6.1 Production Environment Specification
SlateMatch is deployed on **Amazon ECS Express Mode (ap-south-1, Mumbai)** using **Amazon ECR** for container registry storage, behind the Express Mode HTTPS endpoint.

* **Live Endpoint:** assigned when the ECS service is created and recorded here at deployment.
* **AWS Region:** `ap-south-1`
* **Container Port:** `8080`
* **ALB Health Check:** `GET /health` (expects HTTP `200 OK`)
* **Task Resources:** 0.25 vCPU, 1 GB memory, non-root container execution. Autoscaling is capped at 3 tasks as a credit guard on the account's $120 of credits; the service burns roughly $28 per month.
* **Two health surfaces:** the ECS health check reads `/health` (which also carries the AI state and the model metrics); the container's own Docker HEALTHCHECK probes `/ready`. Different layers, both expected green.

### Service Environment (ECS task definition)
| Variable | Production value |
| :--- | :--- |
| `SLATEMATCH_DATA_DIR` | `/tmp/slatematch-data` (ephemeral by design - see 6.5) |
| `GEMINI_API_KEY` | Set. The value is never printed; diagnostics reports only the AI state. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `SLATEMATCH_BOOTSTRAP_KEY` | Deliberately unset: the public demo runs in dev-open mode and `/health` prints `"auth": "dev-open"`. A paid deployment sets this key and issues tenant API keys. |

## 6.2 Deploying a New Release
Production releases do not use a local script: the path is GitHub Actions plus one action in the ECS console.

1. Copy the changed files into the repository and commit (GitHub Desktop), then Push origin.
2. GitHub Actions runs the test job; on green, it builds the image and pushes it to ECR (section 6.3).
3. In the ECS console, open the `slatematch` service (Express Mode, cluster `default`) and choose **Update service**. ECS rolls the new task in, verifies `/health`, and drains the previous task.
4. Run the post-deployment verification checklist (section 6.4). Note that workspace data lives in the task's `/tmp` and resets on redeploy; re-seed the demo case from Use Cases (one action).

**Rollback:** every build is tagged in ECR with both `:latest` and its commit SHA. To roll back, Update service against the previous SHA tag (or revert the commit and push, which rebuilds it). Workspace data resets on any redeploy, either way.

A `deploy.sh` file exists in the repository root, but it is a legacy Google Cloud Run helper from an earlier hosting evaluation. It is not part of the production path and must not be used to deploy this service.

## 6.3 CI/CD Pipeline (`.github/workflows/build-ecr.yml`)
On every push to `main`, GitHub Actions:
1. Runs the full test gate in a dedicated test job: the `pytest` suite (134 tests across 29 modules) and the Rust kernel's `cargo test`.
2. Blocks image publication if any unit, accounting, or UI contract test fails (a red test job skips the build job entirely).
3. Builds and pushes the verified container image to Amazon ECR.

The workflow authenticates with the `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_ACCOUNT_ID` repository secrets, held by the dedicated `github-deployer` IAM user, and pushes both the `:latest` tag and the commit-SHA tag.

## 6.4 Post-Deployment Verification Checklist
1. **Health Probe:** Open `/health` and confirm HTTP 200 and `"status": "ok"`.
2. **Subsystem Diagnostics:** Open `11 Agent Health` in the UI (or `GET /api/v1/diagnostics`) and verify:
   * The Rust kernel equivalence probe passes against the Python reference.
   * The AI state reports Gemini configured with no last error (a live parse returns `source: gemini`).
   * SQLite `WAL` mode is active (a code-level property - every database opens with `journal_mode=WAL` and a 5000 ms busy timeout; the diagnostics payload does not expose it, so this item is verified in the repository code and the suite rather than in the UI).
3. **End-to-End Smoke Test:** Load the Demo Case (`19` open invoices, `16` staged wires), verify the Staged Readiness Panel on `01 Dashboard`, click **Run Reconciliation**, and confirm `10` auto-posted matches (`411,800.00`), `5` held matches (`223,150.00`), and `1` exception.

## 6.5 Data Persistence and the Pilot Path
Workspace data is ephemeral in this deployment by design: the task's `/tmp` resets on redeploy, which keeps the public demo self-cleaning and cost-free. Persistence is named as the first task of a paid pilot, and the migration path is specified: all product state flows through one persistence seam (`backend/app/repository.py`, one SQLite database per tenant), so the pilot move is to re-point that seam at durable storage - an EFS-mounted data directory holding the same SQLite files as the smallest step, or a Postgres-backed repository implementation behind the same interface for a multi-task deployment. No other module touches the database directly.

---

Version 3.1 | 3 Nov 2026 | Owner: C. Harsha Vardhana Reddy
