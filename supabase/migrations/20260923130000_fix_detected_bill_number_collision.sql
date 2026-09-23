-- create_detected_bill built its bill_number as 'EMAIL-' || to_char(now(), 'YYYYMMDDHH24MISS'),
-- which has one-second resolution, while bills carries a unique constraint on
-- (user_id, bill_number). Two bills detected for the same user within the same second therefore
-- collide and the second one is rejected outright.
--
-- Not hypothetical: driving six forwarded bills through the pipeline back-to-back on 2026-09-23
-- lost one of them to exactly this ("duplicate key value violates unique constraint
-- bills_user_number_unique", Key (user_id, bill_number)=(..., EMAIL-20260923121454)). It surfaces
-- precisely when a user first connects forwarding and a batch of mail arrives at once — the worst
-- possible moment for a bill to silently not appear. (The queue's retry did recover it on the next
-- attempt, a second later, but that's luck, not a guarantee: a user forwarding enough mail can
-- burn all three attempts on collisions and lose the bill for good.)
--
-- Fixed by appending a short random suffix rather than by switching to a sequence: the number is a
-- human-facing reference on a detected bill, not an accounting document number that has to be
-- gapless, and a suffix keeps the existing sortable-timestamp shape intact.
--
-- Everything below the bill_number expression is unchanged from
-- 20260921150001_add_bill_detection_and_reminders.sql.
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
    p_user_id,
    'EMAIL-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
    'pending_review', p_vendor_name, p_vendor_address, p_vendor_email,
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
