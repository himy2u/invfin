-- A client with neither email nor phone can never receive an invoice or its delivery-status
-- notifications — the product's entire wedge is proving delivery/open status, which is
-- impossible without a channel to deliver through. Enforce at the DB level, not just in the UI.

alter table clients
  add constraint clients_has_contact_method
  check (email is not null or phone is not null);
