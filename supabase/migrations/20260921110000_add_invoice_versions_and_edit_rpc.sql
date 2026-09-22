-- Real gap: once created, an invoice could only be viewed, exported, or sent — never corrected.
-- A typo in a line item or a wrong due date had no fix path. This adds editing plus a version
-- history: every edit snapshots the invoice + line items as they were BEFORE the change, so past
-- states are recoverable (never overwritten silently) — the same "don't lie about what happened"
-- principle behind never guessing payment status extends to not silently rewriting invoice history.

create table invoice_versions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version_number integer not null,
  -- Full snapshot of the invoice row + its line items as they were immediately BEFORE this edit,
  -- so any past version can be inspected without reconstructing it from a diff.
  snapshot jsonb not null,
  created_at timestamptz not null default now(),

  constraint invoice_versions_unique unique (invoice_id, version_number)
);

create index invoice_versions_invoice_id_idx on invoice_versions (invoice_id);

alter table invoice_versions enable row level security;

create policy "invoice_versions_select_own" on invoice_versions
  for select using (auth.uid() = user_id);
create policy "invoice_versions_insert_own" on invoice_versions
  for insert with check (auth.uid() = user_id);

-- Editing is only meaningful before money has changed hands or the invoice is dead: a paid invoice
-- must not be silently rewritten (the exact thing payments-safety.md's "never lie about what
-- happened" principle rules out for status; the same reasoning extends to the billed amount once
-- paid), and a voided invoice has nothing left to correct.
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
