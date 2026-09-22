-- Security fix: create_invoice_with_line_items and create_estimate_with_line_items never verified
-- p_client_id belongs to the calling user — verified exploitable: any authenticated user could
-- create an invoice/estimate against ANY OTHER USER'S client id. Not a direct data leak (RLS still
-- blocks reading the victim's client row), but it lets a tenant attach records to another tenant's
-- client, blocks the real owner from deleting that client (FK is ON DELETE RESTRICT), and is a
-- cross-tenant UUID-existence oracle. convert_estimate_to_invoice was already safe (it copies
-- client_id from an ownership-scoped select) — only the two create functions needed the check.

create or replace function create_invoice_with_line_items(
  p_client_id uuid,
  p_invoice_number text,
  p_currency text,
  p_issue_date date,
  p_due_date date default null,
  p_terms text default null,
  p_notes text default null,
  p_line_items jsonb default '[]'::jsonb,
  p_title text default null,
  p_summary text default null,
  p_po_number text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_subtotal_cents bigint := 0;
  v_tax_cents bigint := 0;
  v_discount_cents bigint := 0;
  v_item jsonb;
  v_line_subtotal bigint;
  v_line_tax bigint;
  v_index integer := 0;
begin
  if not exists (select 1 from clients where id = p_client_id and user_id = auth.uid()) then
    raise exception 'client not found';
  end if;
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'invoice must have at least one line item';
  end if;

  insert into invoices (
    user_id, client_id, invoice_number, status, currency, issue_date, due_date, terms, notes,
    title, summary, po_number
  ) values (
    auth.uid(), p_client_id, p_invoice_number, 'draft', p_currency, p_issue_date, p_due_date, p_terms, p_notes,
    p_title, p_summary, p_po_number
  )
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_line_subtotal := round((v_item->>'quantity')::numeric * (v_item->>'unit_price_cents')::bigint);
    v_line_tax := round(v_line_subtotal * (coalesce(v_item->>'tax_rate_percent', '0'))::numeric / 100);

    insert into invoice_line_items (
      invoice_id, user_id, description, quantity, unit_price_cents,
      tax_rate_percent, tax_label, discount_cents, sort_order
    ) values (
      v_invoice_id, auth.uid(), v_item->>'description', (v_item->>'quantity')::numeric,
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

  update invoices
  set subtotal_cents = v_subtotal_cents,
      tax_cents = v_tax_cents,
      discount_cents = v_discount_cents,
      total_cents = v_subtotal_cents + v_tax_cents - v_discount_cents
  where id = v_invoice_id;

  return v_invoice_id;
end;
$$;

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
  if not exists (select 1 from clients where id = p_client_id and user_id = auth.uid()) then
    raise exception 'client not found';
  end if;
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

  if v_subtotal_cents + v_tax_cents - v_discount_cents < 0 then
    raise exception 'discount cannot exceed subtotal plus tax';
  end if;

  update estimates
  set subtotal_cents = v_subtotal_cents,
      tax_cents = v_tax_cents,
      discount_cents = v_discount_cents,
      total_cents = v_subtotal_cents + v_tax_cents - v_discount_cents
  where id = v_estimate_id;

  return v_estimate_id;
end;
$$;

-- Same discount-exceeds-total guard for the edit path — previously relied on the incidental
-- amount_paid_not_over_total constraint firing with a confusing raw error.
create or replace function update_invoice_with_line_items(
  p_invoice_id uuid,
  p_due_date date default null,
  p_terms text default null,
  p_notes text default null,
  p_title text default null,
  p_summary text default null,
  p_po_number text default null,
  p_line_items jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_next_version integer;
  v_snapshot jsonb;
  v_subtotal_cents bigint := 0;
  v_tax_cents bigint := 0;
  v_discount_cents bigint := 0;
  v_item jsonb;
  v_line_subtotal bigint;
  v_line_tax bigint;
  v_index integer := 0;
begin
  select * into v_invoice from invoices where id = p_invoice_id and user_id = auth.uid();
  if not found then
    raise exception 'invoice not found';
  end if;
  if v_invoice.status in ('paid', 'partially_paid', 'void') then
    raise exception 'cannot edit an invoice once it is %', v_invoice.status;
  end if;
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'invoice must have at least one line item';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next_version
  from invoice_versions where invoice_id = p_invoice_id;

  select jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'line_items', coalesce(jsonb_agg(to_jsonb(li) order by li.sort_order), '[]'::jsonb)
  ) into v_snapshot
  from invoice_line_items li
  where li.invoice_id = p_invoice_id;

  insert into invoice_versions (invoice_id, user_id, version_number, snapshot)
  values (p_invoice_id, auth.uid(), v_next_version, v_snapshot);

  delete from invoice_line_items where invoice_id = p_invoice_id;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_line_subtotal := round((v_item->>'quantity')::numeric * (v_item->>'unit_price_cents')::bigint);
    v_line_tax := round(v_line_subtotal * (coalesce(v_item->>'tax_rate_percent', '0'))::numeric / 100);

    insert into invoice_line_items (
      invoice_id, user_id, description, quantity, unit_price_cents,
      tax_rate_percent, tax_label, discount_cents, sort_order
    ) values (
      p_invoice_id, auth.uid(), v_item->>'description', (v_item->>'quantity')::numeric,
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

  update invoices
  set due_date = p_due_date,
      terms = p_terms,
      notes = p_notes,
      title = p_title,
      summary = p_summary,
      po_number = p_po_number,
      subtotal_cents = v_subtotal_cents,
      tax_cents = v_tax_cents,
      discount_cents = v_discount_cents,
      total_cents = v_subtotal_cents + v_tax_cents - v_discount_cents,
      updated_at = now()
  where id = p_invoice_id;

  return p_invoice_id;
end;
$$;

-- Non-negative guards on line-item money/quantity fields — verified a negative quantity times a
-- negative unit price produced a positive, misleading subtotal with no error at all.
alter table invoice_line_items
  add constraint invoice_line_items_quantity_non_negative check (quantity >= 0),
  add constraint invoice_line_items_unit_price_non_negative check (unit_price_cents >= 0),
  add constraint invoice_line_items_discount_non_negative check (discount_cents >= 0);

alter table estimate_line_items
  add constraint estimate_line_items_quantity_non_negative check (quantity >= 0),
  add constraint estimate_line_items_unit_price_non_negative check (unit_price_cents >= 0),
  add constraint estimate_line_items_discount_non_negative check (discount_cents >= 0);

alter table products
  add constraint products_default_price_non_negative check (default_price_cents >= 0),
  add constraint products_default_tax_rate_non_negative check (default_tax_rate_percent >= 0);
