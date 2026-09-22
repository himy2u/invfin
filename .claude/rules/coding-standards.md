# Coding standards

- TypeScript strict mode everywhere (`apps/web`, `apps/mobile`, `packages/core`). No `any` without
  a one-line comment saying why it's unavoidable.
- Shared types/logic (invoice model, pricing, API client) live in `packages/core` and are imported
  by both apps — never duplicated between web and mobile.
- Reuse before adding: extend an existing function/component before writing a new one; grep for an
  existing implementation first.
- No premature abstraction: three similar lines beats a helper used once. No feature flags or
  backwards-compat shims for code that hasn't shipped yet.
- Tests colocated with source (`*.test.ts`), run via `turbo test`. A fix to a webhook/payment path
  gets tested against one real Stripe test-mode event, not just a mock.
- structlog-equivalent (`pino` on the Node/Next side) for anything server-side; no bare
  `console.log` left in committed server code.
