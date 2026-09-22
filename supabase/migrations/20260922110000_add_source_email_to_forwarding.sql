-- The forwarding mechanism itself never needed to know which inbox a user forwards FROM — a
-- webhook matches purely on the private token in the recipient address, so any source inbox works
-- with zero backend change. But a real user setting this up has no way to confirm/remember which
-- of their email accounts they pointed at the generated address, since the wizard never asked.
-- This column is purely for that display/reference purpose — it is never read by the matching
-- logic in services/agent/email_bill_router.py, only shown back to the user in the UI.
alter table email_forwarding_addresses
  add column source_email text;
