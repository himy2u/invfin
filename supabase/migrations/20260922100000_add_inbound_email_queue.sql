-- Decouples the inbound-email webhook's fast ack from the actual bill classify/extract work.
-- Previously /inbound-email ran the Gemini classify+extract calls SYNCHRONOUSLY inside the
-- webhook request. That has no margin: some inbound-email providers hard-timeout webhooks at 10s
-- (this app currently targets Postmark, which tolerates longer, but the design shouldn't assume
-- that forever), and — more importantly — every provider retry on a slow/failed attempt RE-RUNS
-- the LLM call against the same email, multiplying cost with no cap. Moving the message into this
-- table first (with its own unique constraint on message_id) makes the idempotency check a plain
-- INSERT conflict, resolved BEFORE any LLM spend, and lets the webhook return in well under a
-- second regardless of how slow the actual extraction turns out to be.
create table inbound_email_queue (
  id uuid primary key default gen_random_uuid(),
  forwarding_token text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  subject text not null default '',
  body_text text not null default '',
  message_id text not null unique,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index inbound_email_queue_status_idx on inbound_email_queue (status);

-- No RLS policies granting anon/authenticated access — this table is never read or written by
-- either app directly, only by the agent service's service-role client (same reasoning as
-- create_detected_bill/claim_bill_reminder: no end-user JWT context applies here). RLS is still
-- enabled so a future PostgREST exposure mistake fails closed instead of open.
alter table inbound_email_queue enable row level security;

-- Atomic claim, folding in two fixes a review pass caught before this shipped:
--   1. attempts is incremented as PART of the claim itself, not after processing finishes — so a
--      crash between claiming and finishing (process killed mid-Gemini-call, a redeploy, etc.)
--      still counts as an attempt. Without this, a row that crashes processing every time would
--      cycle between "stuck in processing" and "reclaimed" forever, never hitting the retry cap.
--   2. the WHERE clause also reclaims rows stuck in 'processing' for more than 5 minutes — a
--      watchdog for exactly that same crash scenario, since nothing else ever un-sticks a row
--      left in 'processing' by a process that died before marking it done/failed.
create or replace function claim_inbound_email_queue_row(p_id uuid)
returns inbound_email_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row inbound_email_queue;
begin
  update inbound_email_queue
  set status = 'processing', claimed_at = now(), attempts = attempts + 1
  where id = p_id
    and (status = 'pending' or (status = 'processing' and claimed_at < now() - interval '5 minutes'))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function claim_inbound_email_queue_row from public, anon, authenticated;
grant execute on function claim_inbound_email_queue_row to service_role;

-- Same shape, for the sweep endpoint (/process-email-queue) which claims a whole batch rather than
-- one row at a time — used for crash recovery (stale 'processing' rows) and, once a real scheduler
-- exists for this service, as the periodic catch-all for anything a request-scoped background task
-- didn't get to finish.
create or replace function claim_inbound_email_queue_batch(p_limit integer)
returns setof inbound_email_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update inbound_email_queue
  set status = 'processing', claimed_at = now(), attempts = attempts + 1
  where id in (
    select id from inbound_email_queue
    where status = 'pending' or (status = 'processing' and claimed_at < now() - interval '5 minutes')
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

revoke execute on function claim_inbound_email_queue_batch from public, anon, authenticated;
grant execute on function claim_inbound_email_queue_batch to service_role;
