---
name: add-migration
description: Use when adding or changing a database table/column in invfin's Supabase Postgres schema.
---

# Add a migration

1. Migrations live in `supabase/migrations/` — generate with `supabase migration new <name>`, never
   hand-edit the schema in the Supabase dashboard for anything beyond a quick local experiment.
2. Every new table needs RLS (row-level security) policies before it ships — Supabase defaults to
   RLS-off on new tables, which would expose merchant/customer data across tenants.
3. Run `supabase db reset` locally to replay all migrations and confirm the chain applies cleanly
   before pushing.
4. `supabase db push` to apply to the hosted project — confirm which environment (dev/prod project)
   first; Supabase projects are separate, there's no single "staging vs prod" flag like a
   traditional single-Postgres setup.
