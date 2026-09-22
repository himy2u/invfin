-- Wave's "Contact info" screens split the primary contact into first/last name, allow up to a few
-- additional contacts, and carry a private account number, website (shown on invoices), and private
-- notes — none of which we had (clients only had a single flat name/email/phone). Additional
-- contacts are a small, user-editable list with no independent identity of their own (no login, no
-- FK targets elsewhere), so a jsonb column carries them instead of a full child table + RLS set.

alter table clients
  add column first_name text,
  add column last_name text,
  add column account_number text,
  add column website text,
  add column private_notes text,
  add column additional_contacts jsonb not null default '[]'::jsonb;

comment on column clients.additional_contacts is
  'Array of {name, email, phone} objects — extra contacts beyond the primary name/email/phone columns.';
