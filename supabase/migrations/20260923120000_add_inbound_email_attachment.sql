-- Two unrelated-looking additions that are both about the same gap: the inbound-email pipeline
-- only ever looked at an email's plain-text body, and the user had no way to re-drive it by hand.

-- 1. Attachment carry-through.
--
-- Postmark's inbound webhook delivers attachments inline (base64) on the same payload as the body,
-- but InboundEmailPayload only read Subject/TextBody, so they were dropped on the floor. A real
-- forwarded bill ("Fwd: Contributie - factuur 40023635", 2026-09-23) proved why that matters: the
-- body said only "herewith you receive an invoice" — every number was in the attached PDF — so the
-- pipeline processed it to 'done' and produced no bill at all.
--
-- The classify/extract work happens in a background task reading this row back, not in the webhook
-- request, so the attachment has to be persisted here or it's gone by the time anything can use it.
-- Only ONE attachment is stored (the first PDF/image; see _select_bill_attachment), not an array:
-- a bill email has one bill document, and the rest of a real forwarded email's attachments are
-- logos, tracking pixels, and .ics invites. Content is kept in the exact base64 form Postmark sent
-- so nothing has to re-encode it, and the router caps the decoded size before it ever gets here.
alter table inbound_email_queue add column attachment_name text;
alter table inbound_email_queue add column attachment_mime_type text;
alter table inbound_email_queue add column attachment_content text;

-- 2. A user-scoped claim, for the "Check for new bills" button.
--
-- claim_inbound_email_queue_batch already exists but is global (it's the cross-tenant sweep the
-- /process-email-queue endpoint runs behind webhook credentials). A button in the app is acted on
-- by one signed-in user and must only ever touch that user's own rows — filtering in Python after
-- a global claim would be wrong, not just inefficient: it would claim, and thereby consume an
-- attempt on, other tenants' rows. Claim semantics (status gate, 5-minute staleness reclaim,
-- attempts increment, skip locked) are otherwise identical to the global version on purpose, so a
-- user pressing the button races the automatic path safely instead of double-processing a row.
create or replace function claim_inbound_email_queue_batch_for_user(p_user_id uuid, p_limit integer)
returns setof inbound_email_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update inbound_email_queue
  set status = 'processing', claimed_at = now(), attempts = attempts + 1
  where id in (
    select id from inbound_email_queue
    where user_id = p_user_id
      and (status = 'pending' or (status = 'processing' and claimed_at < now() - interval '5 minutes'))
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

revoke execute on function claim_inbound_email_queue_batch_for_user from public, anon, authenticated;
grant execute on function claim_inbound_email_queue_batch_for_user to service_role;
