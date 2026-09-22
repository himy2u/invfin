# Architecture

## Monorepo layout

```
invfin/
├── apps/
│   ├── web/        Next.js — dashboard + customer-facing pay page
│   └── mobile/     Expo/React Native — iOS + Android from one codebase
├── packages/
│   └── core/       shared TS types, invoice/pricing logic, API client
├── services/
│   └── agent/      Python, uv-managed — agentic invoice creation + photo/PDF import parsing
└── supabase/
    └── migrations/ Postgres schema (Supabase-hosted)
```

pnpm workspaces + Turborepo tie the TS side together (`turbo build`/`turbo test`); `services/agent`
is a separate `uv`-managed Python project, called over HTTP from the Next.js API routes — see
`../rules/dev-environment.md`.

## Data flow: an invoice's life

0. Creation can start three ways: manual form (TS apps only), natural-language/photo/PDF via
   `services/agent` (uploads land in S3-compatible storage — LocalStack locally, real cloud storage
   in prod — the agent service parses/generates, returns a draft for the user to confirm, never
   auto-submits silently), or CSV/platform-export import.
1. Merchant creates invoice (web or mobile) → row in `invoices` table, status `draft`.
2. On send: `checkout.sessions.create` against the merchant's Stripe Connect account → email sent
   via Postmark/SES from a per-merchant authenticated subdomain → status `sent`.
3. Postmark/SES webhook → `delivered` / `opened` / `bounced` recorded on the invoice.
4. If bounced or unopened after 48h → Twilio SMS/WhatsApp fallback fires with the same payment link.
5. Stripe webhook (`checkout.session.completed`) → status `paid`. This is the ONLY path to `paid` —
   see `../rules/payments-safety.md`.

## Environments

Two Supabase projects minimum: one for dev/test/evals, one for production — never point a local
run, a test, or an eval at the production project. Stripe needs no separate account for this:
test-mode keys and Stripe's test-mode webhooks cover dev/test entirely; only production deploys
use live keys. Same logic for Postmark/Twilio — use their sandbox/test modes locally.

## Why Supabase, why Stripe Connect

Supabase bundles Postgres + auth + row-level security in one hosted service — right-sized for a
two-app monorepo that needs auth and a DB without standing up separate infra. Stripe Connect
because we are explicitly not building a payment rail or holding funds (see `payments-safety.md`)
— Connect's Standard/Express account types push KYC/compliance onto Stripe.
