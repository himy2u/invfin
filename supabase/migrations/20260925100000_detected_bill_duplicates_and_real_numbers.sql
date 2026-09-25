-- Three things a live end-to-end test of email bill detection turned up, all in create_detected_bill:
--
--   1. The vendor's own invoice number was thrown away. An email plainly saying "Invoice CW-20461"
--      still produced bill_number = 'EMAIL-<timestamp>-<random>', which is the one reference the user
--      CAN'T use when they ring the vendor about it. The generated form stays as the fallback for the
--      (common) case where the email states no number at all.
--
--   2. A manually re-forwarded email created a second, indistinguishable bill. Dedupe was keyed only
--      on Postmark's MessageID, which is per-delivery, and this app's own setup instructions tell
--      users to forward their existing backlog by hand once, because Gmail filters only apply going
--      forward. Same bill, new MessageID, second row.
--
--   3. profiles.reminder_channels had no row for real accounts, so every reminder send logged
--      "failed to read reminder_channels, defaulting to all on". The default is fine; persisting a
--      state where we don't actually know the user's preference is not.
--
-- Everything not called out below is carried over verbatim from
-- 20260924100000_add_fine_grained_reminder_timing.sql.

-- Flagged, not deduplicated away. Silently dropping the second copy would be wrong in the case that
-- actually costs money: a vendor genuinely billing the same amount twice (a monthly retainer with no
-- invoice number, two identical deposits) would vanish, and the user would underpay with no way to
-- discover why. Naming the match and leaving both rows in the review queue, where Dismiss already
-- sits one click away, puts the judgement where it belongs while still making the two rows tellable
-- apart, which is the actual bug.
alter table bills
  add column duplicate_of_bill_id uuid references bills (id) on delete set null;

-- Only ever read for a bill sitting in review, so the index is scoped to that.
create index bills_duplicate_of_idx on bills (duplicate_of_bill_id) where duplicate_of_bill_id is not null;

-- DROP then CREATE, not CREATE OR REPLACE. Adding a parameter changes the signature, so a replace
-- would leave the old 9-argument function in place as an overload, and a 9-argument call would then
-- match both (the new one via its default), which Postgres rejects outright as "function is not
-- unique". Dropping first leaves exactly one function, which the not-yet-redeployed agent service's
-- 9-argument call still resolves against via the default.
drop function if exists create_detected_bill(uuid, text, text, date, date, text, text, text, jsonb);

create function create_detected_bill(
  p_user_id uuid,
  p_vendor_name text,
  p_currency text,
  p_issue_date date,
  p_due_date date,
  p_vendor_address text default null,
  p_vendor_email text default null,
  p_detected_email_message_id text default null,
  p_line_items jsonb default '[]'::jsonb,
  -- New, and last + defaulted so the existing 9-argument call shape keeps working during the window
  -- between this migration applying and the agent service being redeployed (services/agent has no
  -- auto-deploy on push, so that window is real and not hypothetical).
  p_invoice_number text default null
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
  v_bill_number text;
  v_duplicate_of uuid;
begin
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'bill must have at least one line item';
  end if;

  -- Guarantees a profiles row exists before anything reads reminder_channels off it. Cheap, idempotent,
  -- and it fires at the first moment this user has anything to be reminded about.
  insert into profiles (user_id) values (p_user_id) on conflict (user_id) do nothing;

  select reminder_days_before_default into v_reminder_days from profiles where user_id = p_user_id;

  -- The total has to be known BEFORE the insert now, because duplicate detection matches on it.
  -- (It used to be computed by a follow-up UPDATE after the line items were inserted; that UPDATE is
  -- still there, and still the thing that actually sets the column, so the two can't disagree.)
  select coalesce(sum(round((item->>'quantity')::numeric * (item->>'unit_price_cents')::bigint)), 0)
    into v_subtotal_cents
    from jsonb_array_elements(p_line_items) as item;

  -- Same vendor, same total, same due date, still live (not dismissed, not paid), inside a window
  -- wide enough to catch a backlog forward but not so wide that next quarter's identical retainer
  -- invoice matches last quarter's. `is not distinct from` rather than `=` so two bills that both
  -- have no due date still compare equal.
  select id into v_duplicate_of
    from bills
   where user_id = p_user_id
     and status in ('pending_review', 'unpaid')
     and vendor_name = p_vendor_name
     and total_cents = v_subtotal_cents
     and due_date is not distinct from p_due_date
     and created_at > now() - interval '60 days'
   order by created_at asc
   limit 1;

  -- The vendor's stated number wins when there is one: it is what the user and the vendor both
  -- reconcile by. Truncated and collision-suffixed rather than allowed to fail, because
  -- bills_user_number_unique is a hard constraint and a collision here is EXPECTED: a re-forwarded
  -- bill carries the same invoice number by definition, which is the case (2) above.
  v_bill_number := nullif(btrim(coalesce(p_invoice_number, '')), '');
  if v_bill_number is not null then
    v_bill_number := left(v_bill_number, 100);
    if exists (select 1 from bills where user_id = p_user_id and bill_number = v_bill_number) then
      v_bill_number := v_bill_number || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
    end if;
  else
    v_bill_number :=
      'EMAIL-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into bills (
    user_id, bill_number, status, vendor_name, vendor_address, vendor_email,
    currency, issue_date, due_date, source, detected_email_message_id,
    reminder_mode, reminder_offset_value, reminder_offset_unit, duplicate_of_bill_id
  ) values (
    p_user_id, v_bill_number,
    'pending_review', p_vendor_name, p_vendor_address, p_vendor_email,
    p_currency, coalesce(p_issue_date, current_date), p_due_date, 'email', p_detected_email_message_id,
    'offset', least(coalesce(v_reminder_days, 2), 60), 'days', v_duplicate_of
  )
  returning id into v_bill_id;

  v_subtotal_cents := 0;
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

-- Backfill for accounts that already exist. Same reasoning as the insert inside the function above:
-- the fallback-to-all-channels behaviour is correct, but leaving live accounts in a state where the
-- service warns on every single reminder send hides real warnings behind noise.
insert into profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;
