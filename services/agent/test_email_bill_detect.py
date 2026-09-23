from email_bill_detect import detect_gmail_confirmation_link

# Captured verbatim from a real Gmail forwarding-confirmation email via the Postmark API
# (2026-09-23) — the previous fixture here was a guessed "confirmation code" template that never
# matched reality; Gmail actually sends a confirm LINK, not a typed code. Direct fixture text, no
# live network call needed (see the comment in email_bill_detect.py on why this is regex-based,
# not an LLM call). This is the ONLY way the user ever sees this link, so it gets direct coverage
# rather than relying on the general classify/extract path to happen to also handle it.
GMAIL_CONFIRMATION_BODY = """humanrav@gmail.com has requested to automatically forward mail to your email
address 77882e438c2440fb8ba0f0860f5b9bd5@inbox.housing360.app.

To allow humanrav@gmail.com to automatically forward mail to your address,
please click the link below to confirm the request:

https://mail-settings.google.com/mail/vf-%5BANGjdJ-xZYOlOd0sd3XGb93Ajik81JYjqMfDFztpKSJN9HacF1CD-oucNhd3eTKItZ4GFal_-vd97u3-tlUzLypFZJodxGBrZsJW4kgfu14bUDklziOKcwPxLGC2xiM%5D-GA-lLaZOWeQekwVixkq8b0_ypPk

If you click the link and it appears to be broken, please copy and paste it
into a new browser window.

If you do not approve of this request, no further action is required.
humanrav@gmail.com cannot automatically forward messages to your email address
unless you confirm the request by clicking the link above. If you accidentally
clicked the link, but you do not want to allow humanrav@gmail.com to
automatically forward messages to your address, click this link to cancel this
verification:
https://mail-settings.google.com/mail/uf-%5BANGjdJ8JlEwEVrTSwP_sbwifKW6vwbo3BElZCMJZGzZEr_g2UyRDad84BZdFzGUSILWzOzHID46vNT8xFN2Mq4XDBSI-aKaD2jMkfY0QGupdXrzN4Zt5D7h3wrr7K90%5D-GA-lLaZOWeQekwVixkq8b0_ypPk
"""


def test_detects_confirmation_link_from_real_template() -> None:
    link = detect_gmail_confirmation_link("(Gmail Forwarding Confirmation - Receive Mail from humanrav@gmail.com", GMAIL_CONFIRMATION_BODY)
    assert link is not None
    assert link.startswith("https://mail-settings.google.com/mail/vf-")


def test_detects_confirmation_link_on_the_other_real_host_variant() -> None:
    # Same Gmail account, a different confirmation attempt minutes apart, used
    # mail.google.com instead of mail-settings.google.com — both are real, both must match.
    body = "please click the link below to confirm the request:\n\nhttps://mail.google.com/mail/vf-abcXYZ123\n"
    link = detect_gmail_confirmation_link("Gmail Forwarding Confirmation", body)
    assert link == "https://mail.google.com/mail/vf-abcXYZ123"


def test_does_not_return_the_cancel_link() -> None:
    link = detect_gmail_confirmation_link("(Gmail Forwarding Confirmation - Receive Mail from humanrav@gmail.com", GMAIL_CONFIRMATION_BODY)
    assert "/mail/uf-" not in (link or "")


def test_returns_none_for_unrelated_email() -> None:
    link = detect_gmail_confirmation_link("Your invoice from Acme", "Please pay $50 by Friday.")
    assert link is None


def test_returns_none_when_forwarding_mentioned_but_no_link() -> None:
    link = detect_gmail_confirmation_link("Forwarding enabled", "Forwarding has been turned on for your account.")
    assert link is None
