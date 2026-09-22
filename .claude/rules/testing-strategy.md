# Testing strategy

Wired from Phase 1, not bolted on later — CI runs all of this on every PR (GitHub Actions).

- **Web unit/component**: Vitest + React Testing Library.
- **Web E2E**: Playwright.
- **Mobile unit/component**: Jest + React Native Testing Library.
- **Mobile E2E**: Maestro (YAML-defined flows, works against Expo, less flaky than Detox for a
  small team to maintain).
- **Python agent service**: pytest, run via `uv run pytest`.
- **API/integration**: hit the dev/test Supabase project + Stripe test mode + LocalStack — real
  dependencies, not mocks, for anything touching payments or delivery status
  (`payments-safety.md`).

A feature isn't "done" without its layer's test passing in CI — matches the build process (small
tested steps, main always deployable) already agreed with the user.
