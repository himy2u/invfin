-- Security fix: insert policies on invoice_line_items, estimate_line_items, and invoice_versions
-- checked only `auth.uid() = user_id` — the row's OWN user_id — never that the invoice_id/
-- estimate_id foreign key actually points at a parent the caller owns. Verified exploitable: any
-- authenticated user could insert a line item (or a version-history row) against ANY OTHER USER'S
-- invoice by setting invoice_id to the victim's invoice and user_id to themselves. RLS SELECT
-- stayed correctly scoped (no data leak), but the injected row silently survives every edit the
-- real owner makes (update_invoice_with_line_items deletes by invoice_id only, and its own delete
-- is scoped to the invoker's rows) — a stranger can permanently pollute another user's invoice and
-- its audit trail. This directly undermines the "never lie about what happened" premise the audit
-- trail exists for.

drop policy "invoice_line_items_insert_own" on invoice_line_items;
create policy "invoice_line_items_insert_own" on invoice_line_items
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from invoices i where i.id = invoice_id and i.user_id = auth.uid())
  );

drop policy "estimate_line_items_insert_own" on estimate_line_items;
create policy "estimate_line_items_insert_own" on estimate_line_items
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from estimates e where e.id = estimate_id and e.user_id = auth.uid())
  );

drop policy "invoice_versions_insert_own" on invoice_versions;
create policy "invoice_versions_insert_own" on invoice_versions
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from invoices i where i.id = invoice_id and i.user_id = auth.uid())
  );

-- Same gap existed on UPDATE for line items (a user could reassign an owned line item onto another
-- user's invoice by changing invoice_id) — close it the same way.
drop policy "invoice_line_items_update_own" on invoice_line_items;
create policy "invoice_line_items_update_own" on invoice_line_items
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from invoices i where i.id = invoice_id and i.user_id = auth.uid())
  );

drop policy "estimate_line_items_update_own" on estimate_line_items;
create policy "estimate_line_items_update_own" on estimate_line_items
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from estimates e where e.id = estimate_id and e.user_id = auth.uid())
  );

-- Second fix: clients.additional_contacts is a jsonb column with no shape validation — verified an
-- object, a bare string, or a JSON-null literal (distinct from SQL NULL, so it bypasses `not null`)
-- can all be written today. The web client-edit form casts this straight to a typed Contact[] with
-- no runtime check, so a malformed value hard-crashes that client's edit page with no recovery path
-- short of a manual DB fix.
alter table clients
  add constraint clients_additional_contacts_is_array
  check (jsonb_typeof(additional_contacts) = 'array');
