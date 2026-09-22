-- Estimates were in the original PRD's Phase 2 scope ("Estimates -> convert to invoice with one
-- click") but never got built. Wave's "New estimate" screens confirm the shape: draft status,
-- "Valid until" date, optional deposit request, convertible to an invoice with one click.
-- Mirrors the invoices/invoice_line_items structure rather than reusing those tables directly —
-- an estimate is not an invoice (no payment tracking, different status lifecycle) until converted.

create type estimate_status as enum (
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'converted'
);

create table estimates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null references clients (id) on delete restrict,

  estimate_number text not null,
  status estimate_status not null default 'draft',

  currency text not null default 'USD',
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,

  title text,
  summary text,
  issue_date date not null default current_date,
  valid_until date,
  terms text,
  notes text,

  deposit_requested_cents bigint,

  sent_at timestamptz,
  -- Set once this estimate has been turned into an invoice — a one-way pointer, since converting
  -- back the other direction isn't a real workflow.
  converted_invoice_id uuid references invoices (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint estimates_user_number_unique unique (user_id, estimate_number)
);

create index estimates_user_id_idx on estimates (user_id);
create index estimates_client_id_idx on estimates (client_id);
create index estimates_status_idx on estimates (status);

create table estimate_line_items (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references estimates (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  description text not null,
  quantity numeric not null default 1,
  unit_price_cents bigint not null default 0,
  tax_rate_percent numeric not null default 0,
  tax_label text not null default 'Tax',
  discount_cents bigint not null default 0,

  sort_order integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index estimate_line_items_estimate_id_idx on estimate_line_items (estimate_id);
create index estimate_line_items_user_id_idx on estimate_line_items (user_id);

alter table estimates enable row level security;
alter table estimate_line_items enable row level security;

create policy "estimates_select_own" on estimates
  for select using (auth.uid() = user_id);
create policy "estimates_insert_own" on estimates
  for insert with check (auth.uid() = user_id);
create policy "estimates_update_own" on estimates
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "estimates_delete_own" on estimates
  for delete using (auth.uid() = user_id);

create policy "estimate_line_items_select_own" on estimate_line_items
  for select using (auth.uid() = user_id);
create policy "estimate_line_items_insert_own" on estimate_line_items
  for insert with check (auth.uid() = user_id);
create policy "estimate_line_items_update_own" on estimate_line_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "estimate_line_items_delete_own" on estimate_line_items
  for delete using (auth.uid() = user_id);

create or replace function create_estimate_with_line_items(
  p_client_id uuid,
  p_estimate_number text,
  p_currency text,
  p_issue_date date,
  p_valid_until date default null,
  p_terms text default null,
  p_notes text default null,
  p_line_items jsonb default '[]'::jsonb,
  p_title text default null,
  p_summary text default null,
  p_deposit_requested_cents bigint default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_estimate_id uuid;
  v_subtotal_cents bigint := 0;
  v_tax_cents bigint := 0;
  v_discount_cents bigint := 0;
  v_item jsonb;
  v_line_subtotal bigint;
  v_line_tax bigint;
  v_index integer := 0;
begin
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'estimate must have at least one line item';
  end if;

  insert into estimates (
    user_id, client_id, estimate_number, status, currency, issue_date, valid_until, terms, notes,
    title, summary, deposit_requested_cents
  ) values (
    auth.uid(), p_client_id, p_estimate_number, 'draft', p_currency, p_issue_date, p_valid_until, p_terms, p_notes,
    p_title, p_summary, p_deposit_requested_cents
  )
  returning id into v_estimate_id;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_line_subtotal := round((v_item->>'quantity')::numeric * (v_item->>'unit_price_cents')::bigint);
    v_line_tax := round(v_line_subtotal * (coalesce(v_item->>'tax_rate_percent', '0'))::numeric / 100);

    insert into estimate_line_items (
      estimate_id, user_id, description, quantity, unit_price_cents,
      tax_rate_percent, tax_label, discount_cents, sort_order
    ) values (
      v_estimate_id, auth.uid(), v_item->>'description', (v_item->>'quantity')::numeric,
      (v_item->>'unit_price_cents')::bigint, coalesce((v_item->>'tax_rate_percent')::numeric, 0),
      coalesce(v_item->>'tax_label', 'Tax'),
      coalesce((v_item->>'discount_cents')::bigint, 0), v_index
    );

    v_subtotal_cents := v_subtotal_cents + v_line_subtotal;
    v_tax_cents := v_tax_cents + v_line_tax;
    v_discount_cents := v_discount_cents + coalesce((v_item->>'discount_cents')::bigint, 0);
    v_index := v_index + 1;
  end loop;

  update estimates
  set subtotal_cents = v_subtotal_cents,
      tax_cents = v_tax_cents,
      discount_cents = v_discount_cents,
      total_cents = v_subtotal_cents + v_tax_cents - v_discount_cents
  where id = v_estimate_id;

  return v_estimate_id;
end;
$$;

-- One-click "convert to invoice": copies the estimate + its line items into a brand-new invoice
-- (draft status, today's issue date), then marks the estimate converted and links it. Runs as the
-- calling user (security invoker) so RLS on both tables still applies.
create or replace function convert_estimate_to_invoice(
  p_estimate_id uuid,
  p_invoice_number text
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_estimate estimates%rowtype;
  v_invoice_id uuid;
begin
  select * into v_estimate from estimates where id = p_estimate_id and user_id = auth.uid();
  if not found then
    raise exception 'estimate not found';
  end if;
  if v_estimate.status = 'converted' then
    raise exception 'estimate already converted';
  end if;

  insert into invoices (
    user_id, client_id, invoice_number, status, currency, issue_date, terms, notes,
    title, summary, subtotal_cents, discount_cents, tax_cents, total_cents
  ) values (
    auth.uid(), v_estimate.client_id, p_invoice_number, 'draft', v_estimate.currency, current_date,
    v_estimate.terms, v_estimate.notes, v_estimate.title, v_estimate.summary,
    v_estimate.subtotal_cents, v_estimate.discount_cents, v_estimate.tax_cents, v_estimate.total_cents
  )
  returning id into v_invoice_id;

  insert into invoice_line_items (
    invoice_id, user_id, description, quantity, unit_price_cents,
    tax_rate_percent, tax_label, discount_cents, sort_order
  )
  select v_invoice_id, auth.uid(), description, quantity, unit_price_cents,
         tax_rate_percent, tax_label, discount_cents, sort_order
  from estimate_line_items
  where estimate_id = p_estimate_id;

  update estimates
  set status = 'converted', converted_invoice_id = v_invoice_id
  where id = p_estimate_id;

  return v_invoice_id;
end;
$$;
