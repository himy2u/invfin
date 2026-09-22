from email_bill_detect import detect_gmail_confirmation_code

# Gmail's actual confirmation email template — direct fixture text, no live network call needed
# (see the comment in email_bill_detect.py on why this is regex-based, not an LLM call). This is
# the ONLY way the user ever learns this code, so it gets direct coverage rather than relying on
# the general classify/extract path to happen to also handle it.
GMAIL_CONFIRMATION_BODY = """You have requested to have emails forwarded to bills+abc123@inbox.invfin.app.

To confirm this is correct, please enter the following confirmation code:

Confirmation code: 5271914

If you did not request this, ignore this email.
"""


def test_detects_confirmation_code_from_real_template() -> None:
    code = detect_gmail_confirmation_code("Gmail Forwarding Confirmation - Receive Emails from ...", GMAIL_CONFIRMATION_BODY)
    assert code == "5271914"


def test_returns_none_for_unrelated_email() -> None:
    code = detect_gmail_confirmation_code("Your invoice from Acme", "Please pay $50 by Friday.")
    assert code is None


def test_returns_none_when_forwarding_mentioned_but_no_code() -> None:
    code = detect_gmail_confirmation_code("Forwarding enabled", "Forwarding has been turned on for your account.")
    assert code is None
