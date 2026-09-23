import asyncio
import os
import secrets
from datetime import date, datetime, timezone
from email.utils import getaddresses

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from postgrest.exceptions import APIError
from pydantic import BaseModel

from db import get_service_client
from email_bill_detect import (
    CLASSIFY_CONFIDENCE_THRESHOLD,
    BillExtractionFailed,
    classify_bill_email,
    detect_gmail_confirmation_link,
    extract_bill_from_email,
)
from logging_setup import logger
from mailer import send_bill_reminder_email
from push import send_push_notification
from reminder_scheduling import reminder_due_today

router = APIRouter()
_security = HTTPBasic()

# Postmark's inbound payload can carry a large attachment/body — same reasoning as
# _MAX_UPLOAD_BYTES in main.py: unbounded size costs memory/CPU and Gemini spend with no
# legitimate upside for a bill email, which is plain text.
_MAX_BODY_CHARS = 200_000


def _verify_webhook_auth(credentials: HTTPBasicCredentials = Depends(_security)) -> None:
    expected_user = os.environ.get("INBOUND_EMAIL_WEBHOOK_USER", "")
    expected_password = os.environ.get("INBOUND_EMAIL_WEBHOOK_PASSWORD", "")
    # HTTP Basic Auth (checked with secrets.compare_digest to avoid a timing side-channel), not a
    # URL query-param secret — a token embedded in the URL lands in web-server access logs, browser
    # history if ever opened manually, and Postmark's own delivery-log UI, all of which are broader
    # exposure surfaces than an auth header that's never logged by default.
    user_ok = secrets.compare_digest(credentials.username, expected_user)
    password_ok = secrets.compare_digest(credentials.password, expected_password)
    if not (user_ok and password_ok):
        raise HTTPException(401, "invalid webhook credentials")


class InboundEmailPayload(BaseModel):
    Subject: str = ""
    TextBody: str = ""
    MessageID: str
    OriginalRecipient: str = ""
    To: str = ""


# Required, not defaulted — a hardcoded fallback here would silently accept mail addressed to the
# wrong domain in whichever environment forgot to set this (e.g. a preprod subdomain vs prod's),
# matching this codebase's existing fail-loud convention for required config (GEMINI_API_KEY,
# SUPABASE_SERVICE_ROLE_KEY). Read once at import time since ENABLE_EMAIL_BILL_DETECTION already
# gates whether this module gets imported at all.
_FORWARDING_DOMAIN = os.environ["EMAIL_FORWARDING_DOMAIN"]


def _extract_forwarding_token(payload: InboundEmailPayload) -> str | None:
    # A naive split on the first "@" breaks on the two most common real header shapes: a display
    # name ("Bills <token@inbox.invfin.app>") and a multi-recipient header
    # ("user@personal.com, token@inbox.invfin.app") — both produce garbage before ever reaching an
    # "@". email.utils.getaddresses parses RFC 5322 address lists correctly, and matching by domain
    # (rather than "whichever address came first") finds our address regardless of position or
    # how many other recipients are listed.
    candidates = getaddresses([payload.OriginalRecipient, payload.To])
    for _display_name, address in candidates:
        if "@" not in address:
            continue
        local_part, _, domain = address.partition("@")
        if domain.strip().lower() == _FORWARDING_DOMAIN:
            return local_part.strip().lower() or None
    return None


_DEFAULT_CHANNELS = {"push": True, "email": True, "in_app": True}


def _get_reminder_channels(client, user_id: str) -> dict:
    # Split out of _notify_user so preference resolution can be reasoned about (and tested)
    # independently of the send fan-out below it.
    try:
        profile = client.table("profiles").select("reminder_channels").eq("user_id", user_id).single().execute()
        return (profile.data or {}).get("reminder_channels") or dict(_DEFAULT_CHANNELS)
    except Exception as exc:
        logger.warning("failed to read reminder_channels, defaulting to all on", error=str(exc), user_id=user_id)
        return dict(_DEFAULT_CHANNELS)


def _notify_user(client, user_id: str, bill_id: str | None, title: str, body: str, notif_type: str) -> None:
    # Three independent try/excepts (in-app write, email, push) rather than one bundled step — a
    # failure in any single channel must never prevent the others from firing, since each is
    # configured/toggled independently in Settings.
    try:
        client.table("notifications").insert(
            {"user_id": user_id, "type": notif_type, "title": title, "body": body, "related_bill_id": bill_id}
        ).execute()
    except Exception as exc:
        logger.warning("in-app notification write failed", error=str(exc), user_id=user_id)

    channels = _get_reminder_channels(client, user_id)

    if channels.get("email", True):
        try:
            user = client.auth.admin.get_user_by_id(user_id)
            email = user.user.email if user and user.user else None
            if email:
                send_bill_reminder_email(email, title, body)
        except Exception as exc:
            logger.warning("reminder email send failed", error=str(exc), user_id=user_id)

    if channels.get("push", True):
        try:
            tokens = client.table("push_tokens").select("expo_push_token").eq("user_id", user_id).execute()
            for row in tokens.data or []:
                send_push_notification(row["expo_push_token"], title, body)
        except Exception as exc:
            logger.warning("push lookup/send failed", error=str(exc), user_id=user_id)


_MAX_QUEUE_ATTEMPTS = 3


def _enqueue_inbound_email(payload: InboundEmailPayload) -> dict[str, str]:
    # Fast path only — everything that touches Gemini has been moved out of here into
    # _process_claimed_row, which runs as a FastAPI background task (see inbound_email() below)
    # instead of blocking the webhook response. The synchronous Gmail-confirmation-code path stays
    # here on purpose: it's a cheap regex match with no LLM involved, and the user is actively
    # watching Settings for it to appear "within a minute" per that page's own copy — queuing it
    # would add latency for no benefit.
    client = get_service_client()
    token = _extract_forwarding_token(payload)

    if token is None:
        logger.warning("inbound email missing a resolvable recipient", message_id=payload.MessageID)
        return {"status": "dead_letter", "reason": "unresolvable_recipient"}

    address_row = (
        client.table("email_forwarding_addresses").select("user_id, enabled").eq("forwarding_token", token).execute()
    )
    if not address_row.data:
        logger.warning("inbound email for unknown forwarding token", token=token, message_id=payload.MessageID)
        return {"status": "dead_letter", "reason": "unknown_token"}

    user_id = address_row.data[0]["user_id"]
    enabled = address_row.data[0]["enabled"]

    body_text = payload.TextBody[:_MAX_BODY_CHARS]

    confirmation_link = detect_gmail_confirmation_link(payload.Subject, body_text)
    if confirmation_link:
        _notify_user(
            client,
            user_id,
            None,
            "Confirm forwarding in Gmail",
            confirmation_link,
            "gmail_confirmation",
        )
        return {"status": "confirmation_relayed"}

    if not enabled:
        return {"status": "ignored", "reason": "detection_disabled"}

    # Idempotency now happens at INSERT time, before any LLM spend — a Postmark retry of the same
    # MessageID hits the unique constraint immediately instead of (as before) only being caught
    # after a full classify+extract call had already run.
    inserted = (
        client.table("inbound_email_queue")
        .upsert(
            {
                "forwarding_token": token,
                "user_id": user_id,
                "subject": payload.Subject,
                "body_text": body_text,
                "message_id": payload.MessageID,
            },
            on_conflict="message_id",
            ignore_duplicates=True,
        )
        .execute()
    )
    if not inserted.data:
        # Conflict — this message_id is already queued (or already processed) from an earlier
        # delivery attempt. Look up its current state rather than assume anything about it.
        existing = client.table("inbound_email_queue").select("id, status").eq("message_id", payload.MessageID).execute()
        existing_id = existing.data[0]["id"] if existing.data else None
        return {"status": "duplicate", "queue_id": existing_id}

    return {"status": "queued", "queue_id": inserted.data[0]["id"]}


def _process_claimed_row(client, row: dict) -> None:
    # Shared by both the request-scoped background task (the common, near-instant path) and the
    # /process-email-queue sweep (crash recovery + eventual consistency net) — one place implements
    # the actual classify/extract/create/notify logic so the two callers can't drift apart.
    row_id = row["id"]
    user_id = row["user_id"]
    message_id = row["message_id"]
    api_key = os.environ["GEMINI_API_KEY"]

    try:
        classification = classify_bill_email(api_key, row["subject"], row["body_text"])
        if not classification.is_bill or classification.confidence < CLASSIFY_CONFIDENCE_THRESHOLD:
            client.table("inbound_email_queue").update(
                {"status": "done", "processed_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", row_id).execute()
            return

        extraction = extract_bill_from_email(api_key, row["subject"], row["body_text"])

        result = client.rpc(
            "create_detected_bill",
            {
                "p_user_id": user_id,
                "p_vendor_name": extraction.vendor_name,
                "p_currency": extraction.currency,
                "p_issue_date": extraction.issue_date,
                "p_due_date": extraction.due_date,
                "p_vendor_address": extraction.vendor_address,
                "p_vendor_email": extraction.vendor_email,
                "p_detected_email_message_id": message_id,
                "p_line_items": [
                    {
                        "description": item.description,
                        "quantity": item.quantity,
                        "unit_price_cents": round(item.unit_price * 100),
                    }
                    for item in extraction.line_items
                ],
            },
        ).execute()
        bill_id = result.data

        client.table("inbound_email_queue").update(
            {"status": "done", "processed_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", row_id).execute()

        _notify_user(
            client,
            user_id,
            bill_id,
            "New bill detected",
            f"We found a bill from {extraction.vendor_name} due {extraction.due_date}. Review it in the app.",
            "bill_detected",
        )
    except (BillExtractionFailed, APIError) as exc:
        # BillExtractionFailed = Gemini's output didn't parse. APIError here is
        # create_detected_bill's own business-rule rejection (e.g. an empty line_items list).
        # attempts was already incremented atomically by the claim query — once it hits the cap,
        # stop retrying and tell the user directly instead of silently dropping the email forever.
        attempts = row.get("attempts", _MAX_QUEUE_ATTEMPTS)
        logger.warning("bill extraction failed to parse", message_id=message_id, attempts=attempts, error=str(exc))
        if attempts >= _MAX_QUEUE_ATTEMPTS:
            client.table("inbound_email_queue").update(
                {"status": "failed", "last_error": str(exc)[:2000]}
            ).eq("id", row_id).execute()
            _notify_user(
                client,
                user_id,
                None,
                "Couldn't read a forwarded bill",
                "We received a bill email but couldn't extract the details automatically. Please add it manually.",
                "bill_extraction_failed",
            )
        else:
            # Back to pending (not failed) — the sweep endpoint will retry it later, up to the cap.
            client.table("inbound_email_queue").update({"status": "pending", "last_error": str(exc)[:2000]}).eq(
                "id", row_id
            ).execute()
    except Exception as exc:
        # Anything else (a dropped Supabase connection, an unexpected Gemini SDK error) — same
        # retry-then-give-up handling as above, not a bare crash that leaves the row stuck.
        # (If the PROCESS itself dies here before this except even runs, the row stays 'processing'
        # — the claim query's 5-minute staleness reclaim is what un-sticks that case, since nothing
        # else ever will.)
        attempts = row.get("attempts", _MAX_QUEUE_ATTEMPTS)
        logger.error("inbound email processing failed", message_id=message_id, attempts=attempts, error=str(exc))
        next_status = "failed" if attempts >= _MAX_QUEUE_ATTEMPTS else "pending"
        client.table("inbound_email_queue").update({"status": next_status, "last_error": str(exc)[:2000]}).eq(
            "id", row_id
        ).execute()


def _extract_claimed_row(rpc_data) -> dict | None:
    # A function returning a single composite row (not setof) comes back from PostgREST as either
    # a bare object or a one-item list depending on the exact RPC shape — handle both rather than
    # assume one, since guessing wrong here would raise on every call instead of just when empty.
    if not rpc_data:
        return None
    if isinstance(rpc_data, list):
        return rpc_data[0] if rpc_data else None
    return rpc_data


def _process_queue_row_sync(queue_id: str) -> None:
    client = get_service_client()
    claimed = client.rpc("claim_inbound_email_queue_row", {"p_id": queue_id}).execute()
    row = _extract_claimed_row(claimed.data)
    if row is None:
        # Nothing to claim — most commonly because /process-email-queue's sweep already picked
        # this row up first. Not an error.
        return
    _process_claimed_row(client, row)


@router.post("/inbound-email")
async def inbound_email(
    request: Request, background_tasks: BackgroundTasks, _auth: None = Depends(_verify_webhook_auth)
) -> dict[str, str]:
    raw = await request.json()
    payload = InboundEmailPayload(**raw)
    logger.info("inbound email received", message_id=payload.MessageID, subject=payload.Subject[:80])
    try:
        # Only Supabase round-trips happen here now — no Gemini call — so this is normally
        # sub-second. Still threaded (same reasoning as /scan-invoice in main.py) and still
        # timeout-bounded, but the bound can be much tighter than before since nothing here is an
        # LLM call.
        result = await asyncio.wait_for(asyncio.to_thread(_enqueue_inbound_email, payload), timeout=10)
    except asyncio.TimeoutError as exc:
        logger.error("inbound email enqueue timed out", message_id=payload.MessageID)
        raise HTTPException(504, "enqueue timed out") from exc
    except Exception as exc:
        logger.error("inbound email enqueue failed", message_id=payload.MessageID, error=str(exc))
        raise HTTPException(502, "enqueue failed — see agent logs") from exc

    if result.get("status") == "queued":
        # Starlette runs a sync background task via its own threadpool AFTER the response is sent —
        # this is what actually decouples "Postmark gets acked" from "the LLM call finishes,"
        # without a persistent polling loop (which would mean every replica of this service races
        # the same queue on a timer — real risk once this runs with >1 instance). In the common
        # case this still starts within milliseconds of the response, so user-visible latency for
        # "bill shows up in Detected Bills" stays close to what it was before this change.
        background_tasks.add_task(_process_queue_row_sync, result["queue_id"])
    return result


_QUEUE_SWEEP_BATCH_SIZE = 20


def _process_email_queue_sync() -> dict[str, int]:
    # Safety net, not the primary path: catches anything a request-scoped background task never
    # got to finish (the process was killed before it ran, or before it finished — the claim
    # query's 5-minute staleness reclaim is what makes those rows visible to this sweep again), and
    # is the integration point for a real external scheduler once one exists for this service (the
    # same open gap /run-reminder-check already has — this doesn't newly introduce it).
    client = get_service_client()
    claimed = client.rpc("claim_inbound_email_queue_batch", {"p_limit": _QUEUE_SWEEP_BATCH_SIZE}).execute()
    rows = claimed.data or []

    processed = 0
    failed = 0
    for row in rows:
        try:
            _process_claimed_row(client, row)
            processed += 1
        except Exception as exc:
            # _process_claimed_row already handles its own known failure modes internally (that's
            # the whole point of it updating status itself) — this is the last-resort catch so one
            # row's unexpected error can't stop the rest of the batch from being swept.
            failed += 1
            logger.error("queue sweep failed to process a row", queue_id=row.get("id"), error=str(exc))

    return {"claimed": len(rows), "processed": processed, "failed": failed}


@router.post("/process-email-queue")
async def process_email_queue(_auth: None = Depends(_verify_webhook_auth)) -> dict[str, int]:
    logger.info("email queue sweep triggered")
    try:
        result = await asyncio.wait_for(asyncio.to_thread(_process_email_queue_sync), timeout=60)
    except asyncio.TimeoutError as exc:
        logger.error("email queue sweep timed out")
        raise HTTPException(504, "queue sweep timed out") from exc
    except Exception as exc:
        logger.error("email queue sweep failed", error=str(exc))
        raise HTTPException(502, "queue sweep failed — see agent logs") from exc
    logger.info("email queue sweep complete", **result)
    return result


def _run_reminder_check() -> dict[str, int]:
    client = get_service_client()
    today = date.today()

    # This selects every unpaid bill, not just email-detected ones — a manually-created bill can
    # have a null due_date (it's nullable on the base bills table; nothing requires it at manual
    # creation time). Each bill gets its own try/except so one bad row (null/malformed due_date,
    # a claim RPC error, anything) logs and gets skipped instead of aborting the whole batch and
    # silently withholding every OTHER user's reminder for the day.
    bills = (
        client.table("bills")
        .select("id, user_id, vendor_name, due_date, reminder_days_before")
        .eq("status", "unpaid")
        .is_("reminder_sent_at", "null")
        .execute()
    )

    sent = 0
    skipped = 0
    for bill in bills.data or []:
        try:
            if not bill["due_date"]:
                continue
            due = date.fromisoformat(bill["due_date"])
            if not reminder_due_today(due, bill["reminder_days_before"], today):
                continue

            claimed = client.rpc("claim_bill_reminder", {"p_bill_id": bill["id"]}).execute()
            if not claimed.data:
                # Another invocation (a retried cron call) already claimed this bill's reminder —
                # skip rather than double-send.
                continue

            _notify_user(
                client,
                bill["user_id"],
                bill["id"],
                "Bill due soon",
                f"{bill['vendor_name']} is due {bill['due_date']}.",
                "bill_reminder",
            )
            sent += 1
        except Exception as exc:
            skipped += 1
            logger.warning("reminder check skipped a bill due to an error", bill_id=bill.get("id"), error=str(exc))

    return {"checked": len(bills.data or []), "reminders_sent": sent, "skipped": skipped}


@router.post("/run-reminder-check")
async def run_reminder_check(_auth: None = Depends(_verify_webhook_auth)) -> dict[str, int]:
    logger.info("reminder check triggered")
    try:
        result = await asyncio.wait_for(asyncio.to_thread(_run_reminder_check), timeout=60)
    except asyncio.TimeoutError as exc:
        logger.error("reminder check timed out")
        raise HTTPException(504, "reminder check timed out") from exc
    except Exception as exc:
        logger.error("reminder check failed", error=str(exc))
        raise HTTPException(502, "reminder check failed — see agent logs") from exc
    logger.info("reminder check complete", **result)
    return result
