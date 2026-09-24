import base64
import os
import smtplib
from email.message import EmailMessage

import httpx

from logging_setup import logger

# Two transports, chosen by whether POSTMARK_API_KEY is set:
#
#   local dev  -> SMTP to Mailpit (a standalone container dedicated to app-sent email, separate
#                 from Supabase's own internal one, which isn't reachable outside its docker net).
#   deployed   -> Postmark's HTTP send API.
#
# It used to be SMTP unconditionally, defaulting to localhost:1025. The deployed Render container
# has nothing listening there, so every reminder/notification email in production died with
# "[Errno 111] Connection refused", and because _notify_user wraps each channel in its own
# try/except, that was logged as a warning and otherwise swallowed. The user saw the in-app
# notification appear and reasonably assumed the email channel they had enabled was working too.
# An HTTP API is also the right shape for a container platform generally: no outbound SMTP port
# (25/587) to get blocked, no connection pooling to manage across cold starts.
_POSTMARK_SEND_URL = "https://api.postmarkapp.com/email"

# No hardcoded default: the From address must be a sender signature verified in the sending
# Postmark account, so a baked-in fallback would just produce a 422 from Postmark at send time in
# whichever environment forgot to set it. Local dev's Mailpit accepts anything, hence the default
# only on that path.
_LOCAL_DEV_FROM = "bills@invfin.dev"


def _from_address() -> str:
    return os.environ.get("MAIL_FROM_ADDRESS", _LOCAL_DEV_FROM)


def _send_via_smtp(msg: EmailMessage) -> None:
    host = os.environ.get("SMTP_HOST", "localhost")
    port = int(os.environ.get("SMTP_PORT", "1025"))
    with smtplib.SMTP(host, port) as smtp:
        smtp.send_message(msg)


def _send_via_postmark(msg: EmailMessage) -> None:
    body = msg.get_body(preferencelist=("plain",))
    payload: dict = {
        "From": msg["From"],
        "To": msg["To"],
        "Subject": msg["Subject"],
        "TextBody": body.get_content() if body else "",
        "MessageStream": os.environ.get("POSTMARK_MESSAGE_STREAM", "outbound"),
    }

    attachments = [
        {
            "Name": part.get_filename() or "attachment",
            "Content": base64.b64encode(part.get_payload(decode=True) or b"").decode(),
            "ContentType": part.get_content_type(),
        }
        for part in msg.iter_attachments()
    ]
    if attachments:
        payload["Attachments"] = attachments

    response = httpx.post(
        _POSTMARK_SEND_URL,
        json=payload,
        headers={
            "X-Postmark-Server-Token": os.environ["POSTMARK_API_KEY"],
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        timeout=15,
    )
    # Raises on a non-2xx so the caller's own try/except decides what to do. Postmark answers 422
    # with a specific ErrorCode identifying which misconfiguration it was (see _POSTMARK_REASONS
    # below), so log the body before raising, otherwise the reason never reaches the logs.
    if response.status_code >= 400:
        logger.error("postmark send rejected", status=response.status_code, body=response.text[:500])
    response.raise_for_status()


# Postmark's own documented ErrorCode values (postmarkapp.com/developer/api/overview), mapped to
# the reason strings /send-test-reminder reports. Checked against the docs rather than guessed —
# an earlier comment in this file claimed 300 meant "unconfirmed sender signature", which is wrong:
# 300 is generic send validation (bad address, missing body, limits exceeded), so it maps to the
# catch-all send_failed, not to a sender-verification reason the UI would then explain incorrectly.
#
#   400 Sender Signature not found          -> the From address was never added in Postmark
#   401 Sender signature not confirmed      -> added but the confirmation email wasn't clicked
#   405 Not allowed to send                 -> account restricted, in practice pending approval
#   412 While your account is pending approval, all recipients must share the From domain
#   413 This account is not approved to send email
_POSTMARK_REASONS = {
    400: "sender_not_verified",
    401: "sender_not_verified",
    405: "sender_pending_approval",
    412: "sender_pending_approval",
    413: "sender_pending_approval",
}


def postmark_rejection_reason(exc: Exception) -> str:
    """Why a send_* call failed, as one of the reason strings /send-test-reminder reports.

    Pure inspection of an already-raised exception — the send path itself is unchanged, so the real
    reminder cron keeps behaving exactly as before and only the test endpoint reads this."""
    response = getattr(exc, "response", None)
    if response is None:
        return "send_failed"
    try:
        error_code = response.json().get("ErrorCode")
    except Exception:
        return "send_failed"
    return _POSTMARK_REASONS.get(error_code, "send_failed")


def _send(msg: EmailMessage) -> None:
    if os.environ.get("POSTMARK_API_KEY"):
        _send_via_postmark(msg)
    else:
        _send_via_smtp(msg)


def send_invoice_email(
    to: str,
    invoice_number: str,
    total_formatted: str,
    currency: str,
    pdf_bytes: bytes | None = None,
) -> None:
    msg = EmailMessage()
    msg["From"] = _from_address()
    msg["To"] = to
    msg["Subject"] = f"Invoice {invoice_number} — {total_formatted} {currency}"
    msg.set_content(f"You have a new invoice: {invoice_number} for {total_formatted} {currency}.")

    if pdf_bytes is not None:
        msg.add_attachment(
            pdf_bytes,
            maintype="application",
            subtype="pdf",
            filename=f"{invoice_number}.pdf",
        )

    _send(msg)


def send_bill_reminder_email(to: str, subject: str, body_text: str) -> None:
    msg = EmailMessage()
    msg["From"] = _from_address()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body_text)

    _send(msg)
