-- Fine-grained reminder timing: minutes/hours/days before the due date, or an exact date+time.
--
-- Until now a bill's reminder was a single integer, `reminder_days_before`, and
-- reminder_scheduling.py compared whole calendar days only (subtract_business_days(due) == today).
-- There was no way to say "half an hour before" or "at 09:00 next Tuesday", which is what the
-- product owner actually asked for on the review table.
--
-- The old column is MIGRATED, not shadowed: every existing row is converted to
-- (offset, value, 'days') and `reminder_days_before` is dropped in the same migration, so there is
-- exactly one authoritative reminder shape per bill. Running two parallel systems would mean every
-- reader has to know which column wins, which is the bug this feature would most likely ship with.
--
-- `profiles.reminder_days_before_default` is deliberately LEFT ALONE. It is a different thing: the
-- coarse default applied to a newly detected bill before the user has looked at it, set once in
-- Settings. Days granularity is the right granularity for that (nobody sets a global default of
-- "17 minutes"), and the per-bill control is where the fine-grained choice belongs.

alter table bills
  add column reminder_mode text not null default 'offset' check (reminder_mode in ('offset', 'exact')),
  add column reminder_offset_value integer not null default 2,
  add column reminder_offset_unit text not null default 'days' check (reminder_offset_unit in ('minutes', 'hours', 'days')),
  -- Exact mode stores the instant directly: no computation, no timezone ambiguity, whatever the
  -- user picked in their own browser/phone is normalized to UTC on the way in.
  add column reminder_at timestamptz;

-- Data migration for the rows that already exist (there are real production rows with
-- reminder_days_before set). Lossless by construction: N days -> (N, 'days'), which
-- compute_remind_at reproduces via exactly the same subtract_business_days call the old code used.
update bills set reminder_offset_value = reminder_days_before;

alter table bills drop column reminder_days_before;

-- Per-unit bounds rather than one blanket 0-60. The 60 ceiling existed specifically because
-- subtract_business_days loops one calendar day at a time with no upper bound, and an enormous
-- value would spin a reminder-cron worker thread forever (asyncio.wait_for's timeout abandons
-- waiting on the thread but cannot cancel it). That hazard applies ONLY to the days unit —
-- minutes/hours are constant-time timedelta arithmetic — so they get a generous but still finite
-- ceiling (60 days' worth each) purely to keep the value sane and the UI honest.
alter table bills add constraint bills_reminder_offset_value_in_range check (
  (reminder_offset_unit = 'days' and reminder_offset_value between 0 and 60)
  or (reminder_offset_unit = 'hours' and reminder_offset_value between 0 and 1440)
  or (reminder_offset_unit = 'minutes' and reminder_offset_value between 0 and 86400)
);

-- 'exact' without an instant is not a reminder, it is a silent no-op — the one failure mode this
-- product exists to not have. Enforced here rather than in two clients that can both forget.
alter table bills add constraint bills_reminder_exact_requires_instant check (
  reminder_mode = 'offset' or reminder_at is not null
);

-- Re-editing a reminder that already fired re-arms it. Deliberate: a user who deliberately changes
-- when they want to be reminded is asking to be reminded at the new time, and "you already got one,
-- so no" would silently ignore an explicit instruction. Implemented as a trigger, not in the two
-- apps, because both web and mobile PATCH these columns directly through PostgREST and either one
-- forgetting would produce a reminder that never arrives.
--
-- Note this cannot loop: the reminder job's own update touches reminder_sent_at only, never the
-- config columns, so it never re-arms what it just claimed.
create or replace function reset_bill_reminder_on_config_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.reminder_mode is distinct from old.reminder_mode
     or new.reminder_offset_value is distinct from old.reminder_offset_value
     or new.reminder_offset_unit is distinct from old.reminder_offset_unit
     or new.reminder_at is distinct from old.reminder_at then
    new.reminder_sent_at := null;
  end if;
  return new;
end;
$$;

create trigger bills_reset_reminder_on_config_change
  before update on bills
  for each row
  execute function reset_bill_reminder_on_config_change();

-- Replaces the definition from 20260923130000_fix_detected_bill_number_collision.sql. Only the
-- reminder columns on the INSERT change; the bill_number expression and everything below it are
-- carried over verbatim.
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
    currency, issue_date, due_date, source, detected_email_message_id,
    reminder_mode, reminder_offset_value, reminder_offset_unit
  ) values (
    p_user_id,
    'EMAIL-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
    'pending_review', p_vendor_name, p_vendor_address, p_vendor_email,
    p_currency, coalesce(p_issue_date, current_date), p_due_date, 'email', p_detected_email_message_id,
    'offset', least(coalesce(v_reminder_days, 2), 60), 'days'
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

-- The reminder sweep now runs every 5 minutes (see .github/workflows/reminder-check.yml) instead of
-- once a day, so its scan query runs ~288x more often. This is the index that query needs: it reads
-- unpaid bills whose reminder has not fired yet, which is a tiny slice of the table.
create index bills_reminder_pending_idx on bills (status, reminder_sent_at) where reminder_sent_at is null;
