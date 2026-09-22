-- Wave's "New invoice" screen shows a per-invoice Currency picker (defaulting to the business's own
-- currency), a dedicated P.O./S.O. number field, a customizable invoice title, and an optional
-- Summary. We only had a hardcoded "USD" and faked P.O. numbers by stuffing them into the terms
-- text field when scanning a purchase order — real gaps found reviewing Wave's own screens.

alter table profiles
  add column default_currency text not null default 'USD';

alter table clients
  add column default_currency text;

alter table invoices
  add column title text,
  add column summary text,
  add column po_number text;
