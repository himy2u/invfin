# invfin

Invoicing SaaS built to win customers away from Wave / Xero / Square by fixing the one thing they
all get wrong: invoices that are marked "sent" but silently never get seen or paid. See
`.claude/plans/` (created on demand) for the current PRD/pricing/GTM plan — this file only holds
what's true every session.

## What we're building

- Wedge product: create an invoice, send it through an authenticated domain (real SPF/DKIM/DMARC,
  not shared infra), get delivered/opened/bounced telemetry on the invoice itself, auto-fallback to
  SMS/WhatsApp if email bounces or isn't opened in 48h. One fixed template. No ledger, no bank
  feeds, no inventory, no payroll, no multi-currency in v1.
- Target buyer: small/medium businesses and startups with real invoicing volume — **not
  freelancers**. Pricing is usage/outcome/activation-based per contract, not a flat subscription.
  See `.claude/prd/invoicing-wedge-prd.md`.

## Stack

**Reasoned through, not just a default pick (but still not formally signed off by the user —
flag if you'd bet the plan on it):** Stripe Connect for payments, never a custom payment rail or
holding funds ourselves. This is a safety-rail decision (avoids money-transmission licensing) more
than a strategic bet, so it's lower-risk to hold firm than the stack picks below.

**Provisional defaults — not locked in, swap on request (see `.claude/STATE.md`):**
- **Web**: Next.js (App Router) + TypeScript + Tailwind, deployed on Vercel.
- **Mobile (iOS + Android)**: React Native + Expo, one codebase, EAS Build.
- **Shared logic**: `packages/core` in a pnpm + Turborepo monorepo.
- **Backend/DB**: Supabase (Postgres + auth + RLS in one hosted service) — never containerized,
  local or in prod; see `.claude/rules/dev-environment.md`.
- **Agent service**: Python, `uv`-managed, for agentic/LLM invoice creation + photo/PDF import
  parsing — containerized (Cloud Run/Fly.io/Render), not on Vercel.
- **Delivery telemetry**: Postmark or SES webhooks; Twilio for SMS/WhatsApp fallback.
- **Local AWS-service emulation**: LocalStack (e.g. S3 for uploaded invoice files), same
  Terraform-managed code targets real cloud in prod.
- **Analytics/flags**: PostHog Cloud — feature flags from Phase 1, event tracking from Phase 2/3.

Dev/test uses a **separate Supabase project** and Stripe **test mode** keys — never point local
dev or evals at the production project. See `wiki/architecture.md`.

## Conventions

- TypeScript everywhere, strict mode on. No `any` without a comment saying why.
- Reuse before adding: extend an existing function/component before writing a new one.
- No premature abstraction — three similar lines beats a helper used once.
- Tests colocated with source (`*.test.ts`), run via the monorepo's `turbo test`.

## NEVER

- Never build a custom payment processor, hold customer funds, or touch banking rails directly —
  Stripe Connect only.
- Never add a feature cut from v1 scope above without checking with the user first (ledger, bank
  feeds, inventory, payroll, multi-currency, custom branding).
- Never commit secrets (Stripe keys, Supabase service role key, Twilio/Postmark keys) — env vars
  only, never inlined or echoed.

## Pointers

| When you are... | Read |
|---|---|
| about to commit anything | `.claude/rules/git-identity.md` — `himy2u` only, never `hpalldata` |
| touching payment/invoice-status logic | `.claude/rules/payments-safety.md` |
| about to commit or handle any API key | `.claude/rules/secrets-discipline.md` |
| writing code in any package | `.claude/rules/coding-standards.md` |
| building any screen/UI | `.claude/rules/ui-ux-direction.md` — mirror Wave's flow, not its literal visual design |
| choosing infra/hosting, or before letting real users in | `.claude/rules/cloud-portability.md` |
| setting up local dev, the Python agent service, or Docker/LocalStack | `.claude/rules/dev-environment.md` |
| writing or wiring any test | `.claude/rules/testing-strategy.md` |
| needing the monorepo layout or data flow | `.claude/wiki/architecture.md` |
| checking product scope, pricing, or the pain-point evidence | `.claude/prd/invoicing-wedge-prd.md` |
| planning what to build next | `.claude/plans/mvp-build-plan.md` |
| planning GTM / first paying customers | `.claude/plans/day1-revenue-plan.md` |
| deploying web | `.claude/skills/deploy-web/SKILL.md` |
| deploying mobile (TestFlight/Play) | `.claude/skills/deploy-mobile/SKILL.md` |
| wiring or debugging Stripe Connect | `.claude/skills/stripe-connect-setup/SKILL.md` |
| changing the DB schema | `.claude/skills/add-migration/SKILL.md` |
| repeating any OTHER workflow a 2nd time | write it up as `.claude/skills/<name>/SKILL.md` |
| starting a session, or about to end one after substantial work | `.claude/STATE.md` — read it first, update it before stopping |

This file is the single source of truth for agent instructions (Claude Code, Codex, Cursor, etc.
all read it directly or via import — see `.claude/CLAUDE.md`). Keep it under ~150 lines; push
anything longer into a skill or a plan doc and leave one line + pointer here.
