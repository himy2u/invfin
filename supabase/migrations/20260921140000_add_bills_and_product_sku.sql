-- (a) The "From" block on an invoice reads live from `profiles` at render time — it was showing
-- "Your business (not set)" for every new user because nothing ever prompted them to fill it in,
-- even though scanning a timesheet/PO/invoice already extracts the user's OWN business name and
-- address into vendor/vendor_address (added earlier this session) and simply discarded it. No
-- schema change needed for that fix — it's a form-wiring fix — but it's the reason this migration
-- exists alongside the two features below.

-- (b) Bills = accounts payable (money the user OWES a vendor), the mirror image of Invoices
-- (money owed TO the user). Genuinely different from Invoice: no "sent" step, no client-notify
-- email, only a simple unpaid/paid toggle the user flips themselves once they've actually paid the
-- vendor (never inferred, matching the "never lie about what happened" principle applied the other
-- direction). No vendor table — a vendor's name/address/contact are captured as plain fields on the
-- bill itself, the same shape invoice_scan.py already extracts as vendor/vendor_address, since nothing
-- else in the product needs a persistent, editable vendor entity yet (unlike clients, which get
-- reused across many invoices).

create type bill_status as enum ('unpaid', 'paid');

create table bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  bill_number text not null,
  status bill_status not null default 'unpaid',

  vendor_name text not null,
  vendor_address text,
  vendor_email text,
  vendor_phone text,

  currency text not null default 'USD',
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,

  issue_date date not null default current_date,
  due_date date,
  po_number text,
  terms text,
  notes text,

  paid_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bills_user_number_unique unique (user_id, bill_number)
);

create index bills_user_id_idx on bills (user_id);
create index bills_status_idx on bills (status);

create table bill_line_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  description text not null,
  quantity numeric not null default 1,
  unit_price_cents bigint not null default 0,
  tax_rate_percent numeric not null default 0,
  tax_label text not null default 'Tax',
  discount_cents bigint not null default 0,

  sort_order integer not null default 0,

  created_at timestamptz not null default now(),

  constraint bill_line_items_quantity_non_negative check (quantity >= 0),
  constraint bill_line_items_unit_price_non_negative check (unit_price_cents >= 0),
  constraint bill_line_items_discount_non_negative check (discount_cents >= 0)
);

create index bill_line_items_bill_id_idx on bill_line_items (bill_id);
create index bill_line_items_user_id_idx on bill_line_items (user_id);

alter table bills enable row level security;
alter table bill_line_items enable row level security;

create policy "bills_select_own" on bills for select using (auth.uid() = user_id);
create policy "bills_insert_own" on bills for insert with check (auth.uid() = user_id);
create policy "bills_update_own" on bills for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bills_delete_own" on bills for delete using (auth.uid() = user_id);

-- Insert/update ownership-check pattern learned from this session's RLS audit: verify the FK
-- parent belongs to the caller, not just that the row's own user_id matches.
create policy "bill_line_items_select_own" on bill_line_items
  for select using (auth.uid() = user_id);
create policy "bill_line_items_insert_own" on bill_line_items
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from bills b where b.id = bill_id and b.user_id = auth.uid())
  );
create policy "bill_line_items_update_own" on bill_line_items
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from bills b where b.id = bill_id and b.user_id = auth.uid())
  );
create policy "bill_line_items_delete_own" on bill_line_items
  for delete using (auth.uid() = user_id);

create or replace function create_bill_with_line_items(
  p_bill_number text,
  p_vendor_name text,
  p_currency text,
  p_issue_date date,
  p_vendor_address text default null,
  p_vendor_email text default null,
  p_vendor_phone text default null,
  p_due_date date default null,
  p_po_number text default null,
  p_terms text default null,
  p_notes text default null,
  p_line_items jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bill_id uuid;
  v_subtotal_cents bigint := 0;
  v_tax_cents bigint := 0;
  v_discount_cents bigint := 0;
  v_item jsonb;
  v_line_subtotal bigint;
  v_line_tax bigint;
  v_index integer := 0;
begin
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'bill must have at least one line item';
  end if;

  insert into bills (
    user_id, bill_number, vendor_name, vendor_address, vendor_email, vendor_phone,
    currency, issue_date, due_date, po_number, terms, notes
  ) values (
    auth.uid(), p_bill_number, p_vendor_name, p_vendor_address, p_vendor_email, p_vendor_phone,
    p_currency, p_issue_date, p_due_date, p_po_number, p_terms, p_notes
  )
  returning id into v_bill_id;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_line_subtotal := round((v_item->>'quantity')::numeric * (v_item->>'unit_price_cents')::bigint);
    v_line_tax := round(v_line_subtotal * (coalesce(v_item->>'tax_rate_percent', '0'))::numeric / 100);

    insert into bill_line_items (
      bill_id, user_id, description, quantity, unit_price_cents,
      tax_rate_percent, tax_label, discount_cents, sort_order
    ) values (
      v_bill_id, auth.uid(), v_item->>'description', (v_item->>'quantity')::numeric,
      (v_item->>'unit_price_cents')::bigint, coalesce((v_item->>'tax_rate_percent')::numeric, 0),
      coalesce(v_item->>'tax_label', 'Tax'),
      coalesce((v_item->>'discount_cents')::bigint, 0), v_index
    );

    v_subtotal_cents := v_subtotal_cents + v_line_subtotal;
    v_tax_cents := v_tax_cents + v_line_tax;
    v_discount_cents := v_discount_cents + coalesce((v_item->>'discount_cents')::bigint, 0);
    v_index := v_index + 1;
  end loop;

  if v_subtotal_cents + v_tax_cents - v_discount_cents < 0 then
    raise exception 'discount cannot exceed subtotal plus tax';
  end if;

  update bills
  set subtotal_cents = v_subtotal_cents,
      tax_cents = v_tax_cents,
      discount_cents = v_discount_cents,
      total_cents = v_subtotal_cents + v_tax_cents - v_discount_cents
  where id = v_bill_id;

  return v_bill_id;
end;
$$;

create or replace function mark_bill_paid(p_bill_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update bills
  set status = 'paid', paid_at = now(), updated_at = now()
  where id = p_bill_id and user_id = auth.uid();

  if not found then
    raise exception 'bill not found';
  end if;
end;
$$;

-- (c) Auto-learned product catalog: an optional SKU, added now rather than at initial products
-- launch, since only after real scans accumulate real line items does a SKU become meaningful to
-- ask for — this stays nullable/optional exactly as requested, not a required field.
alter table products add column sku text;
