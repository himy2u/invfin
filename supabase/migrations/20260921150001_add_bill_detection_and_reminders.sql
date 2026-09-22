-- Opt-in email bill detection + reminders. Kept modular on purpose (see AGENTS notes in
-- services/agent/email_bill_router.py): every new column here is nullable/defaulted so the
-- existing manual-bill code path (create_bill_with_line_items, the bills list/detail screens)
-- never has to know this feature exists, and every new table is separate rather than folded into
-- an existing one, so dropping this migration's tables and reverting the bills/profiles columns is
-- the whole removal — no shared logic to untangle.

-- One forwarding address per user. The token is a ROUTING key only, never treated as an auth
-- credential — the inbound webhook itself is authenticated separately (HTTP Basic Auth configured
-- on the Postmark side), because a Postmark retry, a misconfigured mail relay, or anyone who
-- guesses/observes a token must never be able to inject a bill into another user's account purely
-- by knowing it.
create table email_forwarding_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  -- Generated server-side (not client-side) so neither app needs a crypto/UUID polyfill just for
  -- this — the mobile app in particular has no built-in crypto.randomUUID.
  forwarding_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table email_forwarding_addresses enable row level security;
create policy "email_forwarding_addresses_select_own" on email_forwarding_addresses
  for select using (auth.uid() = user_id);
create policy "email_forwarding_addresses_insert_own" on email_forwarding_addresses
  for insert with check (auth.uid() = user_id);
create policy "email_forwarding_addresses_update_own" on email_forwarding_addresses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  expo_push_token text not null,
  created_at timestamptz not null default now(),
  constraint push_tokens_user_token_unique unique (user_id, expo_push_token)
);

alter table push_tokens enable row level security;
create policy "push_tokens_select_own" on push_tokens
  for select using (auth.uid() = user_id);
create policy "push_tokens_insert_own" on push_tokens
  for insert with check (auth.uid() = user_id);
create policy "push_tokens_delete_own" on push_tokens
  for delete using (auth.uid() = user_id);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  related_bill_id uuid references bills (id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_id_idx on notifications (user_id, created_at desc);

alter table notifications enable row level security;
create policy "notifications_select_own" on notifications
  for select using (auth.uid() = user_id);
-- Ownership-check pattern required by this project's own RLS audit: insert/update must also
-- confirm related_bill_id (when present) actually belongs to the caller, not just that the row's
-- own user_id matches — otherwise a user could attach a notification to another user's bill.
create policy "notifications_insert_own" on notifications
  for insert with check (
    auth.uid() = user_id
    and (related_bill_id is null or exists (select 1 from bills b where b.id = related_bill_id and b.user_id = auth.uid()))
  );
create policy "notifications_update_own" on notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Both reminder_days_before columns are clamped 0-60 at the DB layer, not just via the frontend's
-- <input max="30"> (a cosmetic HTML attribute only, trivially bypassed with a direct PostgREST
-- PATCH). Without this, an arbitrarily large value reaches reminder_scheduling.py's
-- subtract_business_days, which loops one day at a time with no upper bound — a
-- multi-billion-day value spins a thread-pool worker forever inside the reminder cron's
-- asyncio.to_thread call (asyncio.wait_for's timeout abandons waiting on it but cannot cancel the
-- underlying thread), permanently consuming a worker and blocking every bill queued after it.
alter table bills
  add column source text not null default 'manual' check (source in ('manual', 'email')),
  add column detected_email_message_id text unique,
  add column reminder_days_before integer not null default 2 check (reminder_days_before between 0 and 60),
  add column reminder_sent_at timestamptz;

alter table profiles
  add column reminder_days_before_default integer not null default 2 check (reminder_days_before_default between 0 and 60),
  add column reminder_channels jsonb not null default '{"push": true, "email": true, "in_app": true}'::jsonb;

-- Callable ONLY by the backend service (holding the service-role key) — there is no user JWT on
-- an inbound-email webhook call, so this can't be a normal security-invoker RPC gated on
-- auth.uid(). security definer + revoking execute from the client-facing roles is what makes this
-- safe: an ordinary authenticated user can never call this to create a bill "detected" against
-- someone else's account, because PostgREST (which is what apps/web and apps/mobile actually talk
-- to) only ever presents the anon/authenticated role's privileges to them.
create or replace function create_detected_bill(
  p_user_id uuid,
  p_vendor_name text,
  p_currency text,
  p_issue_date date,
  p_due_date date,
  p_vendor_address text default null,
  p_vendor_email text default null,
  p_detected_email_message_id text default null,
  p_line_items jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill_id uuid;
  v_subtotal_cents bigint := 0;
  v_item jsonb;
  v_line_subtotal bigint;
  v_index integer := 0;
  v_reminder_days integer;
begin
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'bill must have at least one line item';
  end if;

  select reminder_days_before_default into v_reminder_days from profiles where user_id = p_user_id;

  insert into bills (
    user_id, bill_number, status, vendor_name, vendor_address, vendor_email,
    currency, issue_date, due_date, source, detected_email_message_id, reminder_days_before
  ) values (
    p_user_id, 'EMAIL-' || to_char(now(), 'YYYYMMDDHH24MISS'), 'pending_review', p_vendor_name, p_vendor_address, p_vendor_email,
    p_currency, coalesce(p_issue_date, current_date), p_due_date, 'email', p_detected_email_message_id, coalesce(v_reminder_days, 2)
  )
  returning id into v_bill_id;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_line_subtotal := round((v_item->>'quantity')::numeric * (v_item->>'unit_price_cents')::bigint);
    insert into bill_line_items (bill_id, user_id, description, quantity, unit_price_cents, sort_order)
    values (v_bill_id, p_user_id, v_item->>'description', (v_item->>'quantity')::numeric, (v_item->>'unit_price_cents')::bigint, v_index);
    v_subtotal_cents := v_subtotal_cents + v_line_subtotal;
    v_index := v_index + 1;
  end loop;

  update bills set subtotal_cents = v_subtotal_cents, total_cents = v_subtotal_cents where id = v_bill_id;

  return v_bill_id;
end;
$$;

revoke execute on function create_detected_bill from public, anon, authenticated;
grant execute on function create_detected_bill to service_role;

-- These two ARE user-facing (the user reviews and approves/dismisses their own detected bill from
-- the app), so they stay ordinary security-invoker RPCs gated on auth.uid(), same as every other
-- user-facing function in this codebase.
create or replace function approve_detected_bill(p_bill_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update bills set status = 'unpaid', updated_at = now()
  where id = p_bill_id and user_id = auth.uid() and status = 'pending_review';
  if not found then
    raise exception 'bill not found or not pending review';
  end if;
end;
$$;

create or replace function dismiss_detected_bill(p_bill_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update bills set status = 'dismissed', updated_at = now()
  where id = p_bill_id and user_id = auth.uid() and status = 'pending_review';
  if not found then
    raise exception 'bill not found or not pending review';
  end if;
end;
$$;

-- Service-role only, same reasoning as create_detected_bill — the reminder cron has no user JWT.
-- Atomic claim (UPDATE ... WHERE reminder_sent_at IS NULL RETURNING) instead of a separate
-- SELECT-then-INSERT existence check: two concurrent/retried invocations of the reminder job (a
-- retried cron call after a timeout is a completely ordinary real-world event) racing a
-- check-then-act would both see "not yet sent" and both send — this makes only the first caller's
-- update actually return a row, so only one of them proceeds to notify.
create or replace function claim_bill_reminder(p_bill_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed_id uuid;
begin
  -- Also re-checks status = 'unpaid' at claim time, not just at the caller's initial SELECT — the
  -- batch loop in _run_reminder_check can take a while (many bills, per-item round trips), and a
  -- bill paid in the gap between that SELECT and this claim must not still get a stale "due soon"
  -- notification.
  update bills set reminder_sent_at = now()
  where id = p_bill_id and reminder_sent_at is null and status = 'unpaid'
  returning id into v_claimed_id;

  return v_claimed_id is not null;
end;
$$;

revoke execute on function claim_bill_reminder from public, anon, authenticated;
grant execute on function claim_bill_reminder to service_role;
