import os
import smtplib
from email.message import EmailMessage

# Local dev only: a standalone Mailpit container dedicated to app-sent email (separate from
# Supabase's own internal one, which isn't reachable outside its docker network). In preprod/prod
# this becomes Postmark/SES — see .claude/plans/mvp-build-plan.md Phase 3. Lives in the agent
# service (not the Next.js app) because both web and mobile call this service directly already for
# scan/parse, and mobile has no way to reuse a browser session cookie the way a Next.js API route
# would need.
#
# SMTP_HOST/SMTP_PORT default to Mailpit's local address. If a non-local environment forgets to
# set them, this connects to localhost:1025 in a container with nothing listening there — a
# connection-refused error with no hint that env config is missing. Both .env.preprod.example and
# .env.production.example document these explicitly for that reason.


def _send_via_smtp(msg: EmailMessage) -> None:
    host = os.environ.get("SMTP_HOST", "localhost")
    port = int(os.environ.get("SMTP_PORT", "1025"))
    with smtplib.SMTP(host, port) as smtp:
        smtp.send_message(msg)


def send_invoice_email(
    to: str,
    invoice_number: str,
    total_formatted: str,
    currency: str,
    pdf_bytes: bytes | None = None,
) -> None:
    msg = EmailMessage()
    msg["From"] = "invoices@invfin.dev"
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

    _send_via_smtp(msg)


def send_bill_reminder_email(to: str, subject: str, body_text: str) -> None:
    msg = EmailMessage()
    msg["From"] = "bills@invfin.dev"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body_text)

    _send_via_smtp(msg)
