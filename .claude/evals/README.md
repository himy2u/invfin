# Skill evals

Convention: once a skill in `../skills/` has been used a few times, add an eval here as
`<skill-name>/run.sh` + fixtures, testing that following the skill produces the expected outcome
(e.g. `stripe-connect-setup` eval: does the onboarding flow reach `charges_enabled` against a
Stripe test-mode account). Empty until the skills above have real usage to test against —
don't write evals for untested skills.

**Any eval touching the DB or payments runs against the dev/test Supabase project and Stripe test
mode — never production** (see `../wiki/architecture.md` "Environments"). A separate test Supabase
project needs to exist before `stripe-connect-setup` or `add-migration` evals can be written.
