import base64

import httpx
import pytest

import mailer


def test_uses_smtp_when_no_postmark_key(monkeypatch):
    monkeypatch.delenv("POSTMARK_API_KEY", raising=False)
    sent = []
    monkeypatch.setattr(mailer, "_send_via_smtp", lambda msg: sent.append(msg))
    mailer.send_bill_reminder_email("u@example.com", "Bill due soon", "Acme is due 2026-10-01.")
    assert len(sent) == 1
    assert sent[0]["To"] == "u@example.com"


def test_uses_postmark_when_key_is_set(monkeypatch):
    # The production bug this pins: with no POSTMARK_API_KEY branch, the deployed service sent
    # every reminder over SMTP to localhost:1025 and failed with ECONNREFUSED, silently.
    monkeypatch.setenv("POSTMARK_API_KEY", "pm-test-token")
    monkeypatch.setenv("MAIL_FROM_ADDRESS", "support@housing360.app")
    captured = {}

    def fake_post(url, json, headers, timeout):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return httpx.Response(200, json={"ErrorCode": 0}, request=httpx.Request("POST", url))

    monkeypatch.setattr(mailer.httpx, "post", fake_post)
    mailer.send_bill_reminder_email("u@example.com", "Bill due soon", "Acme is due 2026-10-01.")

    assert captured["url"] == mailer._POSTMARK_SEND_URL
    assert captured["headers"]["X-Postmark-Server-Token"] == "pm-test-token"
    assert captured["json"]["From"] == "support@housing360.app"
    assert captured["json"]["To"] == "u@example.com"
    assert captured["json"]["Subject"] == "Bill due soon"
    assert "Acme is due 2026-10-01." in captured["json"]["TextBody"]


def test_postmark_rejection_raises_so_caller_can_log_it(monkeypatch):
    # A 422 (unverified sender signature / account pending approval) must surface as an exception,
    # not a silent no-op. _notify_user's per-channel except is what decides how to report it.
    monkeypatch.setenv("POSTMARK_API_KEY", "pm-test-token")
    monkeypatch.setenv("MAIL_FROM_ADDRESS", "support@housing360.app")

    def fake_post(url, json, headers, timeout):
        return httpx.Response(
            422, json={"ErrorCode": 300, "Message": "Invalid 'From' address"}, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(mailer.httpx, "post", fake_post)
    with pytest.raises(httpx.HTTPStatusError):
        mailer.send_bill_reminder_email("u@example.com", "Bill due soon", "body")


def test_postmark_carries_the_pdf_attachment(monkeypatch):
    monkeypatch.setenv("POSTMARK_API_KEY", "pm-test-token")
    monkeypatch.setenv("MAIL_FROM_ADDRESS", "support@housing360.app")
    captured = {}

    def fake_post(url, json, headers, timeout):
        captured["json"] = json
        return httpx.Response(200, json={"ErrorCode": 0}, request=httpx.Request("POST", url))

    monkeypatch.setattr(mailer.httpx, "post", fake_post)
    mailer.send_invoice_email("c@example.com", "INV-1", "100.00", "USD", pdf_bytes=b"%PDF-fake")

    attachments = captured["json"]["Attachments"]
    assert len(attachments) == 1
    assert attachments[0]["Name"] == "INV-1.pdf"
    assert attachments[0]["ContentType"] == "application/pdf"
    assert base64.b64decode(attachments[0]["Content"]) == b"%PDF-fake"
