-- New enum values only, in their own migration file — Postgres does not allow a newly added enum
-- value to be used by a statement in the same transaction that added it (pre-12 blocks it outright;
-- even on 12+ it's a sharp edge not worth relying on), so the tables/functions that reference
-- 'pending_review'/'dismissed' live in the next migration file instead.
--
-- Reusing the existing bill_status enum for review state (rather than adding a separate
-- review_status column) means "pending" and "dismissed" bills are EXCLUDED from every existing
-- unpaid-total query by construction, since those queries filter on status = 'unpaid'. A parallel
-- review_status column would have required updating apps/web/app/bills/page.tsx and
-- apps/mobile/app/bills/index.tsx to also filter on it — easy to miss, and a missed filter there
-- would have shown an unconfirmed, AI-guessed amount as part of "what you owe," which is exactly
-- the kind of invented number this product exists to never show.
alter type bill_status add value 'pending_review';
alter type bill_status add value 'dismissed';
