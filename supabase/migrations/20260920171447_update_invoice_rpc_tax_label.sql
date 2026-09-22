-- Same as the original create_invoice_with_line_items, plus tax_label per line item.

create or replace function create_invoice_with_line_items(
  p_client_id uuid,
  p_invoice_number text,
  p_currency text,
  p_issue_date date,
  p_due_date date default null,
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
  v_invoice_id uuid;
  v_subtotal_cents bigint := 0;
  v_tax_cents bigint := 0;
  v_discount_cents bigint := 0;
  v_item jsonb;
  v_line_subtotal bigint;
  v_line_tax bigint;
  v_index integer := 0;
begin
  if jsonb_array_length(p_line_items) = 0 then
    raise exception 'invoice must have at least one line item';
  end if;

  insert into invoices (
    user_id, client_id, invoice_number, status, currency, issue_date, due_date, terms, notes
  ) values (
    auth.uid(), p_client_id, p_invoice_number, 'draft', p_currency, p_issue_date, p_due_date, p_terms, p_notes
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

  update invoices
  set subtotal_cents = v_subtotal_cents,
      tax_cents = v_tax_cents,
      discount_cents = v_discount_cents,
      total_cents = v_subtotal_cents + v_tax_cents - v_discount_cents
  where id = v_invoice_id;

  return v_invoice_id;
end;
$$;
