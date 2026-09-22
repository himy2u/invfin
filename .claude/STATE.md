# State

Read this first in any new/resumed session. Update it before ending any substantial chunk of work
— this is the thing that lets a session pick up cold after a disconnect.

## Goal

Build a minimal invoicing product (web + mobile) that wins customers from Wave/Xero/Square by
proving delivery/payment status instead of silently failing, get it to real paying pilots fast, and
validate the problem + willingness-to-switch + willingness-to-pay before over-investing in build.

## Status as of 2026-09-20

**Done:**
- Market research on Wave/Xero/Square complaints (app stores, Reddit, Trustpilot) → identified the
  cross-platform pain point (invoices marked "sent" that silently fail) — see `prd/invoicing-wedge-prd.md`.
- `.claude/` scaffold rebuilt for this project (rules, skills, wiki, prd, plans, commands, evals,
  worktrees, hooks) after an earlier mistake where it was deleted wholesale instead of repurposed.
- `AGENTS.md` written as canonical instructions; `.claude/CLAUDE.md` imports it.
- Scope expanded from "delivery-telemetry wedge only" to the full AR core loop (creation in 3
  modes, tax/discounts/numbering/terms, partial payments, estimates→invoice, void+bulk actions,
  outstanding dashboard) — see PRD v1 list.
- Git initialized, identity set to `himy2u`/`him_y2u@yahoo.com` on this repo specifically, remote
  set to `https://github.com/himy2u/invfin.git`, `gh` active account switched to `himy2u`. User then
  ran `gh auth logout --user hpalldata` themselves — note: that breaks push access for the OTHER
  project (`data_ingest_platform`/`ingestion-service`), which requires `hpalldata`; re-login needed
  there if that project needs a push again.
- Target buyer corrected: **SMB/startups only, not freelancers.** Pricing corrected: usage/outcome/
  activation-based per contract, not flat subscription; validation-stage ask is $10 one-time.
  Reddit dropped as an outreach channel (ban risk) — see `plans/day1-revenue-plan.md` for the
  replacement channels (accountant/bookkeeper partners, LinkedIn, cold email, comparison content,
  warm network).
- Build order changed: invoice creation (3 modes, with known-issue fixes baked in) now precedes
  Stripe/payment integration, which is explicitly deferred to Phase 4 — see `plans/mvp-build-plan.md`.

**NOT done — nothing has been built yet:**
- No monorepo scaffolded, no app code written.
- No real accounts created (Stripe, Supabase, Apple/Google developer, domain) — all still need the
  user's identity/credentials.
- **No validation done yet** that (a) the problem recurs often enough to matter, (b) prospects will
  actually switch tools over it, (c) prospects will pay. Everything in `prd/` and `plans/` is a
  hypothesis from desk research, not confirmed demand. See `plans/mvp-build-plan.md` Phase 0.
- Landing page + $10 payment-link + outreach message drafts offered but not yet built (waiting on
  go-ahead).

## Architecture additions (this session)

- Stack is now polyglot, not pure TS: added `services/agent`, a Python/`uv`-managed service for
  agentic/LLM invoice creation and photo/PDF import parsing (user explicitly chose this over
  staying all-TypeScript when asked). Containerized, deployed separately from Vercel.
- LocalStack for local AWS-service emulation (file storage for imports), Docker for anything that
  needs to run as a standalone service (the Python agent, containerized Next.js) — **DB is the one
  exception, always a managed cloud service, never Docker, local or prod.**
- Testing stack decided: Playwright (web E2E), Vitest+RTL (web unit), Jest+RTL (mobile unit),
  Maestro (mobile E2E), pytest (Python service) — wired in Phase 1, before feature code.
- PostHog: feature flags from Phase 1 (each creation mode ships behind its own flag), event
  tracking added Phase 2/3 so baseline data predates Phase 5 pilots; session replay/heavier
  monitoring deferred, add on demand.
- See `rules/dev-environment.md`, `rules/testing-strategy.md`, `rules/cloud-portability.md`
  (updated with a Phase 6 go-live gate: real Terraform migration attempt + technical/product/data/
  business sign-off before real users).

## Cross-project note (not invfin, but done in this session)

`hpalldata` retired everywhere (employer relationship ended) — local git identity on both
`~/Work/Github/Sequencr-AI/data_ingest_platform` and `~/Work/Github/ingestion-service` switched to
`himy2u`/`him_y2u@yahoo.com`, and their `.claude/CLAUDE.md` + `rules/git-and-trees.md` +
`rules/outward-artifacts.md` updated to match (with the 2026-08-25 incident kept as historical
context for why the rule is enforced strictly either direction).

## Decisions: confirmed vs. provisional

**Confirmed with the user:** the wedge (delivery/payment-status proof) as part of a larger core
loop, Stripe Connect only (no custom payment rail, deferred to Phase 4), target buyer = SMB/startup
only (not freelancers), usage/outcome/activation-based pricing, $10 one-time validation offer, no
Reddit for outreach.

**Provisional / my default pick, not yet confirmed — swap freely if the user has a reason to:**
Next.js for web, Expo/React Native for mobile, Supabase for auth+DB, Postmark/SES for email,
Twilio for SMS. These were chosen because they're the fastest path to a 2-person-team fullstack
build in 2026, not because any alternative was ruled out. Don't treat `AGENTS.md`'s Stack section
as locked — it's a starting point.

## Note on the skills/ files

The 4 SKILL.md files in `skills/` (deploy-web, deploy-mobile, stripe-connect-setup, add-migration)
were written before any of those workflows have been run even once — normally that's an anti-
pattern (skills should get written the 2nd time a workflow repeats, not speculatively). They exist
now because the user explicitly required the full folder scaffold up front. Treat their content as
an untested first draft, not a proven playbook — expect to correct them once each workflow is
actually run for real.

## Open questions for the user

- Has any outreach/pre-sale validation (Phase 0) happened yet, or are we starting cold?
- Any existing accounts (Stripe, domain, etc.) already set up that we should use instead of
  creating new ones?
