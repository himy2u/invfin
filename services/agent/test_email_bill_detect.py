import pytest

from email_bill_detect import (
    BillExtractionFailed,
    BillExtractionResult,
    LineItemDraft,
    _validated_total,
    detect_gmail_confirmation_link,
    find_currency_amounts,
)

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


# --- zero-total guard --------------------------------------------------------------------------
# A real forwarded bill with an itemized product list in the body extracted with the vendor and both
# dates correct and a total of 0.00, and nothing on any screen indicated anything had gone wrong.
# These cover the guard that turns that into either a correct amount or a loud failure. The Gemini
# call itself is not exercised here (that's what the live end-to-end run is for). This is the
# validation applied to whatever it returns.


def test_zero_total_falls_back_to_the_printed_total() -> None:
    result = BillExtractionResult(
        vendor_name="Clayworks Wholesale",
        currency="USD",
        due_date="2026-10-15",
        stated_total_amount=1248.60,
        line_items=[
            LineItemDraft(description="assorted ceramic vases", quantity=24, unit_price=0),
            LineItemDraft(description="scented candle sets", quantity=60, unit_price=0),
        ],
    )
    repaired = _validated_total(result, "Invoice CW-20461", "Total due: $1,248.60")
    assert repaired.total_cents() == 124860
    assert [i.description for i in repaired.line_items] == ["Amount due"]


def test_zero_total_with_no_printed_total_fails_loudly() -> None:
    result = BillExtractionResult(
        vendor_name="Clayworks Wholesale",
        currency="USD",
        due_date="2026-10-15",
        line_items=[LineItemDraft(description="assorted ceramic vases", quantity=24, unit_price=0)],
    )
    with pytest.raises(BillExtractionFailed) as exc:
        _validated_total(result, "Invoice CW-20461", "Amount payable: $1,248.60 by 15 October")
    # The amount the email plainly showed is named in the error, so the failure is diagnosable from
    # the log alone rather than needing the original email re-fetched.
    assert "1248.6" in str(exc.value)


def test_a_correct_total_passes_through_untouched() -> None:
    result = BillExtractionResult(
        vendor_name="Clayworks Wholesale",
        currency="USD",
        due_date="2026-10-15",
        stated_total_amount=1248.60,
        line_items=[
            LineItemDraft(description="assorted ceramic vases", quantity=24, unit_price=12.50),
            LineItemDraft(description="scented candle sets", quantity=60, unit_price=15.81),
        ],
    )
    assert _validated_total(result, "Invoice CW-20461", "Total due: $1,248.60") is result


def test_currency_amounts_require_a_currency_marker() -> None:
    # A quantity in parentheses and a bare invoice number must never read as money, or the guard
    # would "find" an amount in an email that states none.
    assert find_currency_amounts("assorted ceramic vases (24), invoice 20461, due 2026-10-15") == []
    assert find_currency_amounts("Total due: $1,248.60 plus 45.00 EUR shipping") == [1248.6, 45.0]
