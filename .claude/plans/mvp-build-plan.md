# MVP build plan

Phased so something is demoable/sellable early, not a big-bang launch. Order below is deliberate:
**invoice creation comes before payment integration** — Stripe/payment work is explicitly deferred
until creation is solid, not because payments don't matter, but because creation is the part users
touch first and the part where competitors' known issues live.

## Phase 0 — validate BEFORE building (do this first, days not weeks)

The PRD is a hypothesis (see `../prd/invoicing-wedge-prd.md`). Before writing app code, confirm:
1. **Recurs**: talk to/message SMB/startup contacts from `day1-revenue-plan.md`'s channels — does
   the "invoice sent but never landed" failure actually recur for them?
2. **Switch**: would they change tools over it? Ask directly.
3. **Pay**: a no-code Stripe **Payment Link** (dashboard-created, zero engineering) collecting a
   **$10 one-time fee** for early-access, in front of a simple landing page, before the product
   exists. Money moving is the only signal that counts. (This is not the "Stripe work" being
   deferred below — that's the in-product Connect integration for merchants' own customers.)
- Kill/pivot criteria: if paying signups land meaningfully under target, revisit the PRD before
  Phase 1.

## Phase 1 — scaffold (this week)
- pnpm + Turborepo monorepo: `apps/web`, `apps/mobile`, `packages/core`; `services/agent` (Python,
  `uv`-managed) scaffolded separately.
- Testing frameworks wired + CI green on an empty app (`../rules/testing-strategy.md`) — before any
  feature code, not after.
- LocalStack running locally for any AWS-emulated service (`../rules/dev-environment.md`).
- PostHog SDK installed, feature flags available (event tracking comes in Phase 2/3, not yet).
- Supabase project (auth + Postgres + RLS), initial `invoices`/`clients`/`line_items` schema —
  schema already accounts for tax, discounts, custom numbering, terms, partial-payment tracking,
  and void-vs-delete state so Phase 2 isn't a rework.
- No Stripe integration yet.

## Phase 2 — invoice creation, all three modes, fixed not just replicated (weeks 2-3)
- Manual UI: fast form, saved clients, saved line-item/service catalog, per-line tax, discounts,
  custom invoice numbering, terms/notes, due date/payment terms.
- Agentic/natural-language creation via `services/agent` ("bill Acme $500 for design work"), and
  photo/PDF import parsing through the same service — always returns a draft for user confirmation,
  never auto-submits.
- Import: existing invoices/clients from CSV/PDF/another platform's export.
- PostHog event tracking added on key actions (invoice created, sent, paid) so baseline data exists
  before Phase 5 pilots — not instrumented after the fact.
- Each of the three creation modes ships behind its own PostHog feature flag, so they can go live
  independently (matches the agreed build process — flag-gated, main always deployable).
- Estimates → convert to invoice with one click.
- Void (distinct from delete) + bulk void/remind — direct fix for Xero's named complaint.
- No payment collection wired in yet — invoices can be created/sent, marked paid manually for now.

## Phase 3 — delivery telemetry (week 4)
- Authenticated sending domain (SPF/DKIM/DMARC) + Postmark/SES webhooks → sent/delivered/
  opened/bounced visible on the invoice.
- Twilio SMS/WhatsApp fallback on bounce/48h-unopened.
- Outstanding/aging dashboard (one screen: who owes what, how late).

## Phase 4 — payments (deferred until here on purpose)
- Stripe Connect platform account + merchant onboarding.
- Checkout payment link per invoice + webhook → `paid` status (`../rules/payments-safety.md`).
- Partial payments reflected against the schema laid down in Phase 1.

## Phase 5 — ship to pilots
- Mobile TestFlight/Play internal testing build (`../skills/deploy-mobile/SKILL.md`).
- Onboard the day-1 pilot cohort from `day1-revenue-plan.md`.

## Phase 6 — production go-live gate (before opening to real production users)
- Build cloud-portable from Phase 1 on — see `../rules/cloud-portability.md` (Docker-standalone
  Next.js, plain Postgres/RLS, no Supabase-proprietary lock-in).
- Actual Terraform migration attempt to the chosen cloud (GCP/AWS/Azure, user's call) against a
  staging copy — not a theoretical "should port fine."
- Four-lens sign-off before real users get in: technical, product, data, business — each a distinct
  review, not one pass checking all four boxes.

## Definition of done per phase
Each phase runs against real (test-mode where applicable) infra before moving to the next — no
phase is "done" on mocks alone.
