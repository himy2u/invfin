# Cloud portability

The fast MVP stack (Vercel + Supabase) stays as-is for speed — don't rearchitect now. But build it
so it's Terraform-able into GCP/AWS/Azure later without a rewrite:

- **Web**: Next.js in standalone/Docker output mode from day one (`output: 'standalone'`), even
  while deploying to Vercel — makes moving to Cloud Run/ECS/Azure Container Apps a redeploy, not a
  rebuild.
- **DB**: plain Postgres + standard SQL/RLS, no Supabase-proprietary feature we can't get from a
  self-hosted Postgres (e.g. avoid depending on Supabase Edge Functions for anything core — plain
  API routes only) — makes migrating off Supabase to Cloud SQL/RDS/Azure Database a data export +
  Terraform module, not a re-architecture.
- **External SaaS** (Stripe, Postmark/SES, Twilio) are already cloud-agnostic by nature — nothing
  to do here.

**Before any real production user is let in** (after Phase 5 pilots), run a go-live gate:
1. A cloud-infra-focused review (subagent or otherwise) actually attempts the Terraform migration
   to whichever of GCP/AWS/Azure is chosen, against a staging copy — not a theoretical "it should
   port fine."
2. Sign-off across four lenses, not just "tests pass": **technical** (code/infra correctness),
   **product** (does it match the PRD's user-outcome list), **data** (schema integrity, RLS
   correctness, no cross-tenant leaks), **business** (does it match the pricing/contract model in
   the PRD). Each is a distinct review, not one person/agent checking a box four times.
