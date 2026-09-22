# Dev environment: uv, LocalStack, Docker, and the DB exception

- **Python service** (`services/agent` — agentic/LLM orchestration for natural-language invoice
  creation and photo/PDF import parsing): managed with `uv`, never `pip`/`poetry` directly.
  `uv run` for everything, `uv add` for new deps, mirrors the sister project's convention.
- **LocalStack** emulates AWS services (S3 for uploaded invoice photos/PDFs, etc.) locally, so the
  same Terraform-managed infra code that targets LocalStack locally targets real S3/GCS/Azure Blob
  in prod with only the endpoint swapped — no separate "local mode" code path.
- **Docker**: used for anything that needs to run as a standalone service — the Python agent
  service (deploy target: Cloud Run/Fly.io/Render, not Vercel, which doesn't run long-lived Python
  well) and Next.js in standalone output mode (see `cloud-portability.md`).
- **Database is the one thing that's never Docker.** It's always a managed hosted service
  (Supabase now; Cloud SQL/RDS/Azure Database if we migrate later) — never a self-hosted container,
  local or in prod. Both the Node API and the Python agent service connect to it directly via
  connection string; there's no "run Postgres in Docker for local dev" step.
