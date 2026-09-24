import base64
import os
from datetime import datetime, timedelta, timezone

# Force-set (not setdefault) — these tests assert against a specific username/password pair, so
# they must be hermetic against whatever real value happens to already be loaded into the ambient
# environment (e.g. from the repo's .env.local when running the full suite locally).
os.environ["INBOUND_EMAIL_WEBHOOK_USER"] = "testuser"
os.environ["INBOUND_EMAIL_WEBHOOK_PASSWORD"] = "testpass"
os.environ.setdefault("GEMINI_API_KEY", "unused-in-these-tests")
# Force-set for the same reason as the webhook credentials above: these tests build recipient
# addresses at "inbox.invfin.app", so a setdefault let the real EMAIL_FORWARDING_DOMAIN from the
# repo's .env.local ("inbox.housing360.app") win whenever the suite was run with that file sourced.
# Every inbound-email test then dead-lettered with "unresolvable_recipient", a failure that looks
# like a routing regression but is purely ambient-environment leakage.
os.environ["EMAIL_FORWARDING_DOMAIN"] = "inbox.invfin.app"

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

import email_bill_router
import mailer
from email_bill_detect import BillExtractionFailed, BillExtractionResult, ClassifyResult, LineItemDraft

AUTH = ("testuser", "testpass")


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeRpcCall:
    """rpc(...) returns a call object with .execute() (matching supabase-py), not the result
    directly — this wraps an already-computed FakeResult so _claim_queue_row can build one eagerly
    without needing its own two-step builder."""

    def __init__(self, result: FakeResult):
        self._result = result

    def execute(self):
        return self._result


class FakeQuery:
    """Minimal stand-in for supabase-py's fluent query builder — just enough chaining
    (.select/.eq/.is_/.insert/.upsert/.update/.single/.execute) for the exact calls
    email_bill_router.py makes. Real DB behavior (RLS, constraints, atomic claim semantics) is
    covered by the migration having been applied and exercised manually via supabase db reset + the
    RPCs directly; this fake isolates the router's control flow (auth, idempotency, dead-lettering,
    notification fan-out, queue enqueue/update) from network/DB setup."""

    def __init__(self, table_name: str, store: dict):
        self.table_name = table_name
        self.store = store
        self._filters: dict[str, object] = {}
        self._update_payload = None

    def select(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self._filters[key] = value
        return self

    def is_(self, key, value):
        self._filters[key] = None if value == "null" else value
        return self

    def single(self):
        self._single = True
        return self

    def insert(self, payload):
        self.store.setdefault(self.table_name, {"rows": [], "inserts": []})
        self.store[self.table_name]["inserts"].append(payload)
        return self

    def update(self, payload):
        self._update_payload = payload
        return self

    def upsert(self, payload, on_conflict="", ignore_duplicates=False, **_kwargs):
        table = self.store.setdefault(self.table_name, {"rows": [], "inserts": []})
        rows = table["rows"]
        conflict_key = on_conflict or None
        existing = None
        if conflict_key:
            existing = next((r for r in rows if r.get(conflict_key) == payload.get(conflict_key)), None)
        if existing is not None:
            if ignore_duplicates:
                self._upsert_result = []
            else:
                existing.update(payload)
                self._upsert_result = [existing]
        else:
            new_row = dict(payload)
            new_row.setdefault("id", f"generated-{len(rows) + 1}")
            new_row.setdefault("status", "pending")
            new_row.setdefault("attempts", 0)
            rows.append(new_row)
            table["inserts"].append(new_row)
            self._upsert_result = [new_row]
        return self

    def execute(self):
        if hasattr(self, "_upsert_result"):
            return FakeResult(self._upsert_result)

        table = self.store.get(self.table_name, {"rows": []})
        rows = table.get("rows", [])
        matched = [r for r in rows if all(r.get(k) == v for k, v in self._filters.items())]

        if self._update_payload is not None:
            for r in matched:
                r.update(self._update_payload)
            return FakeResult(matched)

        if getattr(self, "_single", False):
            return FakeResult(matched[0] if matched else None)
        return FakeResult(matched)


class FakeAuthAdmin:
    def get_user_by_id(self, user_id):
        class _User:
            def __init__(self, email):
                self.email = email

        class _Response:
            def __init__(self, email):
                self.user = _User(email)

        return _Response(f"{user_id}@example.com")


class FakeAuth:
    admin = FakeAuthAdmin()

    # Only "valid-user-token" mapping to "u1" is recognized — everything else simulates what
    # Supabase's real /auth/v1/user endpoint does for a bad/expired token: reject it.
    def get_user(self, jwt):
        class _User:
            id = "u1"

        class _Response:
            user = _User()

        if jwt == "valid-user-token":
            return _Response()
        return None


class FakeClient:
    def __init__(self, store: dict, rpc_results: dict):
        self.store = store
        self.rpc_results = rpc_results
        self.auth = FakeAuth()

    def table(self, name):
        return FakeQuery(name, self.store)

    def rpc(self, name, params):
        if name == "claim_inbound_email_queue_row":
            return FakeRpcCall(self._claim_queue_row(params["p_id"]))
        if name == "claim_inbound_email_queue_batch_for_user":
            return FakeRpcCall(self._claim_queue_batch_for_user(params["p_user_id"]))
        if name == "claim_bill_reminder":
            return FakeRpcCall(self._claim_bill_reminder(params["p_bill_id"]))
        return FakeRpcCall(FakeResult(self.rpc_results.get(name)))

    def _claim_bill_reminder(self, bill_id):
        # Mirrors the real RPC's atomic claim: the first caller flips reminder_sent_at and gets
        # True, every later caller sees it already set and gets False. This is what makes a bill's
        # reminder fire exactly once even though the sweep now runs every 5 minutes instead of
        # once a day.
        for r in self.store.get("bills", {"rows": []}).get("rows", []):
            if r.get("id") == bill_id and r.get("reminder_sent_at") is None and r.get("status") == "unpaid":
                r["reminder_sent_at"] = "2026-09-24T00:00:00+00:00"
                return FakeResult(True)
        return FakeResult(False)

    def _claim_queue_batch_for_user(self, user_id):
        # Mirrors the real RPC's two load-bearing properties: it claims only rows belonging to the
        # calling user (never another tenant's), and only ones the automatic path hasn't finished.
        rows = self.store.get("inbound_email_queue", {"rows": []}).get("rows", [])
        claimed = []
        for r in rows:
            if r.get("user_id") == user_id and r.get("status") == "pending":
                r["status"] = "processing"
                r["attempts"] = r.get("attempts", 0) + 1
                claimed.append(dict(r))
        return FakeResult(claimed)

    def _claim_queue_row(self, row_id):
        rows = self.store.get("inbound_email_queue", {"rows": []}).get("rows", [])
        for r in rows:
            if r.get("id") == row_id and r.get("status") == "pending":
                r["status"] = "processing"
                r["attempts"] = r.get("attempts", 0) + 1
                return FakeResult(dict(r))
        return FakeResult(None)


def _build_app(store, rpc_results):
    fake_client = FakeClient(store, rpc_results)
    email_bill_router.get_service_client = lambda: fake_client
    app = FastAPI()
    app.include_router(email_bill_router.router)
    return TestClient(app), fake_client


def test_inbound_email_rejects_missing_auth():
    client, _ = _build_app({}, {})
    response = client.post("/inbound-email", json={"MessageID": "m1"})
    assert response.status_code == 401


def test_inbound_email_rejects_wrong_auth():
    client, _ = _build_app({}, {})
    response = client.post("/inbound-email", json={"MessageID": "m1"}, auth=("wrong", "wrong"))
    assert response.status_code == 401


def test_inbound_email_dead_letters_unknown_token():
    store = {"email_forwarding_addresses": {"rows": []}}
    client, _ = _build_app(store, {})
    response = client.post(
        "/inbound-email",
        json={"MessageID": "m1", "Subject": "A bill", "TextBody": "pay up", "OriginalRecipient": "nope@inbox.invfin.app"},
        auth=AUTH,
    )
    assert response.status_code == 200
    assert response.json() == {"status": "dead_letter", "reason": "unknown_token"}


def test_inbound_email_relays_gmail_confirmation_link():
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": False}]}}
    client, _ = _build_app(store, {})
    # Real Gmail forwarding-confirmation emails send a clickable link, not a typed code — see the
    # comment in email_bill_detect.py, verified against a live message.
    body = (
        "please click the link below to confirm the request:\n\n"
        "https://mail-settings.google.com/mail/vf-abc123\n\n"
        "This confirms forwarding to abc123@inbox.housing360.app."
    )
    response = client.post(
        "/inbound-email",
        json={"MessageID": "m2", "Subject": "Gmail Forwarding Confirmation", "TextBody": body, "OriginalRecipient": "abc123@inbox.invfin.app"},
        auth=AUTH,
    )
    assert response.status_code == 200
    assert response.json() == {"status": "confirmation_relayed"}
    assert "https://mail-settings.google.com/mail/vf-abc123" in store["notifications"]["inserts"][0]["body"]


def test_send_test_reminder_rejects_invalid_session():
    client, _ = _build_app({}, {})
    response = client.post("/send-test-reminder", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401


def test_send_test_reminder_rejects_when_no_detected_bill_yet():
    client, _ = _build_app({}, {})
    response = client.post("/send-test-reminder", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 400


def _test_reminder_store(channels=None, push_tokens=()):
    store = {
        "bills": {
            "rows": [
                {
                    "id": "bill-1",
                    "user_id": "u1",
                    "vendor_name": "Acme Water",
                    "due_date": "2026-12-01",
                    "source": "email",
                    "reminder_sent_at": None,
                }
            ]
        },
        "push_tokens": {"rows": [{"user_id": "u1", "expo_push_token": t} for t in push_tokens], "inserts": []},
    }
    if channels is not None:
        store["profiles"] = {"rows": [{"user_id": "u1", "reminder_channels": channels}], "inserts": []}
    return store


def _stub_channels(monkeypatch, *, email=None, push=None):
    """Replaces the two real outbound sends. email=None means "succeeds"; pass an exception to
    raise instead. push=None means "the Expo call succeeded"; pass False for a send that failed."""

    def _email(_to, _subject, _body):
        if email is not None:
            raise email

    monkeypatch.setattr(email_bill_router, "send_bill_reminder_email", _email)
    monkeypatch.setattr(email_bill_router, "send_push_notification", lambda *_args: True if push is None else push)


def _send_test_reminder(client):
    return client.post("/send-test-reminder", headers={"Authorization": "Bearer valid-user-token"})


def test_send_test_reminder_reports_every_channel_delivered(monkeypatch):
    store = _test_reminder_store(push_tokens=("ExponentPushToken[abc]",))
    client, _ = _build_app(store, {})
    _stub_channels(monkeypatch)

    response = _send_test_reminder(client)
    assert response.status_code == 200
    assert response.json() == {
        "bill_id": "bill-1",
        "channels": {
            "in_app": {"attempted": True, "delivered": True},
            "email": {"attempted": True, "delivered": True},
            "push": {"attempted": True, "delivered": True},
        },
    }
    # A test reminder must never mark the real reminder as already sent for this bill.
    assert store["bills"]["rows"][0]["reminder_sent_at"] is None
    notif = store["notifications"]["inserts"][0]
    assert notif["type"] == "bill_reminder"
    assert "Acme Water" in notif["body"]


def test_send_test_reminder_reports_email_blocked_by_pending_approval(monkeypatch):
    # The exact live failure this endpoint used to report as "sent": Postmark 412, the account is
    # still pending approval so it will only deliver to the From address's own domain.
    store = _test_reminder_store(push_tokens=("ExponentPushToken[abc]",))
    client, _ = _build_app(store, {})
    rejection = httpx.HTTPStatusError(
        "422",
        request=httpx.Request("POST", mailer._POSTMARK_SEND_URL),
        response=httpx.Response(422, json={"ErrorCode": 412, "Message": "pending approval"}),
    )
    _stub_channels(monkeypatch, email=rejection)

    body = _send_test_reminder(client).json()
    assert body["channels"]["email"] == {
        "attempted": True,
        "delivered": False,
        "reason": "sender_pending_approval",
    }
    # The other two channels are unaffected — that independence is the whole point.
    assert body["channels"]["in_app"]["delivered"] is True
    assert body["channels"]["push"]["delivered"] is True


def test_send_test_reminder_reports_email_blocked_by_unverified_sender(monkeypatch):
    store = _test_reminder_store()
    client, _ = _build_app(store, {})
    rejection = httpx.HTTPStatusError(
        "422",
        request=httpx.Request("POST", mailer._POSTMARK_SEND_URL),
        response=httpx.Response(422, json={"ErrorCode": 401, "Message": "Sender signature not confirmed"}),
    )
    _stub_channels(monkeypatch, email=rejection)

    body = _send_test_reminder(client).json()
    assert body["channels"]["email"] == {"attempted": True, "delivered": False, "reason": "sender_not_verified"}


def test_send_test_reminder_reports_push_with_zero_registered_devices(monkeypatch):
    # Nothing was ever attempted, so this must not read as either "sent" or "failed to send".
    store = _test_reminder_store(push_tokens=())
    client, _ = _build_app(store, {})
    _stub_channels(monkeypatch)

    body = _send_test_reminder(client).json()
    assert body["channels"]["push"] == {"attempted": False, "delivered": False, "reason": "no_registered_device"}


def test_send_test_reminder_reports_push_turned_off_in_prefs(monkeypatch):
    # Distinct from the zero-devices case above: same attempted=false, different reason, because
    # the UI tells the user to turn it back on rather than to open the app on their phone.
    store = _test_reminder_store(
        channels={"push": False, "email": True, "in_app": True}, push_tokens=("ExponentPushToken[abc]",)
    )
    client, _ = _build_app(store, {})
    _stub_channels(monkeypatch)

    body = _send_test_reminder(client).json()
    assert body["channels"]["push"] == {"attempted": False, "delivered": False, "reason": "channel_disabled"}
    assert body["channels"]["email"]["delivered"] is True


def test_send_test_reminder_reports_a_failing_in_app_insert(monkeypatch):
    store = _test_reminder_store()
    client, fake_client = _build_app(store, {})
    _stub_channels(monkeypatch)

    original_table = fake_client.table

    def _failing_table(name):
        if name == "notifications":
            raise RuntimeError("insert into notifications failed")
        return original_table(name)

    fake_client.table = _failing_table

    body = _send_test_reminder(client).json()
    assert body["channels"]["in_app"] == {"attempted": True, "delivered": False, "reason": "send_failed"}


def test_inbound_email_ignored_when_detection_disabled():
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": False}]}}
    client, _ = _build_app(store, {})
    response = client.post(
        "/inbound-email",
        json={"MessageID": "m3", "Subject": "A bill", "TextBody": "pay $50 by Friday", "OriginalRecipient": "abc123@inbox.invfin.app"},
        auth=AUTH,
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ignored", "reason": "detection_disabled"}


def test_inbound_email_enqueues_and_processes_via_background_task(monkeypatch):
    # TestClient runs a request's background tasks to completion before client.post() returns
    # (Starlette awaits them as part of the same ASGI call), so by the time this assertion runs,
    # the queued row should already have been claimed and marked done by the background task —
    # this is what actually proves the fast-ack-then-process-async wiring works end to end, not
    # just that the enqueue insert happened.
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    rpc_results = {"create_detected_bill": "bill-123"}
    client, fake_client = _build_app(store, rpc_results)

    monkeypatch.setattr(
        email_bill_router,
        "classify_bill_email",
        lambda *_args, **_kwargs: ClassifyResult(is_bill=True, confidence=0.95),
    )
    monkeypatch.setattr(
        email_bill_router,
        "extract_bill_from_email",
        lambda *_args, **_kwargs: BillExtractionResult(
            vendor_name="Acme Electric",
            currency="USD",
            due_date="2026-10-05",
            line_items=[LineItemDraft(description="Amount due", quantity=1, unit_price=50)],
        ),
    )

    response = client.post(
        "/inbound-email",
        json={"MessageID": "m5", "Subject": "Your bill", "TextBody": "pay $50 by Oct 5", "OriginalRecipient": "abc123@inbox.invfin.app"},
        auth=AUTH,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    queue_id = body["queue_id"]

    queued_row = next(r for r in store["inbound_email_queue"]["rows"] if r["id"] == queue_id)
    assert queued_row["status"] == "done"
    assert queued_row["message_id"] == "m5"

    bill_notification = next(n for n in store["notifications"]["inserts"] if n["type"] == "bill_detected")
    assert bill_notification["related_bill_id"] == "bill-123"


def test_inbound_email_duplicate_message_id_not_requeued():
    store = {
        "email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]},
        "inbound_email_queue": {
            "rows": [{"id": "q1", "message_id": "m6", "status": "done", "user_id": "u1", "attempts": 1}],
            "inserts": [],
        },
    }
    client, _ = _build_app(store, {})
    response = client.post(
        "/inbound-email",
        json={"MessageID": "m6", "Subject": "resend", "TextBody": "resend", "OriginalRecipient": "abc123@inbox.invfin.app"},
        auth=AUTH,
    )
    assert response.status_code == 200
    assert response.json() == {"status": "duplicate", "queue_id": "q1"}
    # No second row was created for the same message_id.
    assert len(store["inbound_email_queue"]["rows"]) == 1


def test_process_claimed_row_gives_up_after_max_attempts(monkeypatch):
    store = {}
    fake_client = FakeClient(store, {})

    def _raise_extraction_failed(*_args, **_kwargs):
        raise BillExtractionFailed("malformed output")

    monkeypatch.setattr(
        email_bill_router,
        "classify_bill_email",
        lambda *_args, **_kwargs: ClassifyResult(is_bill=True, confidence=0.9),
    )
    monkeypatch.setattr(email_bill_router, "extract_bill_from_email", _raise_extraction_failed)

    row = {
        "id": "q1",
        "user_id": "u1",
        "subject": "bill",
        "body_text": "bill text",
        "message_id": "m7",
        "attempts": email_bill_router._MAX_QUEUE_ATTEMPTS,
    }
    email_bill_router._process_claimed_row(fake_client, row)

    updated = store["inbound_email_queue"]["rows"][0] if store.get("inbound_email_queue") else None
    # The row started out only in the FakeQuery's update-target lookup, not pre-seeded — assert via
    # the notification instead, which is the user-visible contract that matters here.
    failure_notification = next(n for n in store["notifications"]["inserts"] if n["type"] == "bill_extraction_failed")
    assert failure_notification["user_id"] == "u1"


def test_process_claimed_row_retries_before_max_attempts(monkeypatch):
    store = {"inbound_email_queue": {"rows": [{"id": "q1", "status": "processing"}], "inserts": []}}
    fake_client = FakeClient(store, {})

    def _raise_extraction_failed(*_args, **_kwargs):
        raise BillExtractionFailed("malformed output")

    monkeypatch.setattr(
        email_bill_router,
        "classify_bill_email",
        lambda *_args, **_kwargs: ClassifyResult(is_bill=True, confidence=0.9),
    )
    monkeypatch.setattr(email_bill_router, "extract_bill_from_email", _raise_extraction_failed)

    row = {"id": "q1", "user_id": "u1", "subject": "bill", "body_text": "bill text", "message_id": "m8", "attempts": 1}
    email_bill_router._process_claimed_row(fake_client, row)

    updated = store["inbound_email_queue"]["rows"][0]
    assert updated["status"] == "pending"  # back to pending, not failed — still has retries left
    assert "notifications" not in store  # no premature "couldn't read" notification yet


def test_extract_claimed_row_handles_list_dict_and_empty():
    assert email_bill_router._extract_claimed_row(None) is None
    assert email_bill_router._extract_claimed_row([]) is None
    assert email_bill_router._extract_claimed_row([{"id": "x"}]) == {"id": "x"}
    assert email_bill_router._extract_claimed_row({"id": "x"}) == {"id": "x"}


# --- PDF/image attachment fallback -------------------------------------------------------------
#
# The gap these cover, found against a real forwarded email ("Fwd: Contributie - factuur 40023635",
# 2026-09-23): the pipeline read only TextBody, that email's body said nothing but "herewith you
# receive an invoice," and so it processed cleanly to 'done' and created no bill — every number was
# in the attached PDF it never looked at.

_PDF_BYTES = b"%PDF-1.4 pretend this is a one-page invoice"
_PDF_B64 = base64.b64encode(_PDF_BYTES).decode()


def _recording_detection(monkeypatch, classify, extract):
    """Swaps in stub classify/extract and records the `document` argument each call received, which
    is the thing these tests are actually about: WHICH calls got the attachment, not just that a
    bill came out the other end."""
    calls = {"classify": [], "extract": []}

    def _classify(_api_key, subject, body_text, document=None):
        calls["classify"].append(document)
        return classify(subject, body_text, document)

    def _extract(_api_key, subject, body_text, document=None):
        calls["extract"].append(document)
        return extract(subject, body_text, document)

    monkeypatch.setattr(email_bill_router, "classify_bill_email", _classify)
    monkeypatch.setattr(email_bill_router, "extract_bill_from_email", _extract)
    return calls


def _bill_result(vendor="Vitens", due="2026-10-15", amount=61.4, currency="EUR"):
    return BillExtractionResult(
        vendor_name=vendor,
        currency=currency,
        due_date=due,
        line_items=[LineItemDraft(description="Amount due", quantity=1, unit_price=amount)],
    )


def test_inbound_email_stores_the_first_pdf_and_ignores_other_attachments():
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {})
    response = client.post(
        "/inbound-email",
        json={
            "MessageID": "att1",
            "Subject": "Contributie - factuur 40023635",
            "TextBody": "herewith you receive an invoice",
            "OriginalRecipient": "abc123@inbox.invfin.app",
            "Attachments": [
                {"Name": "invite.ics", "Content": base64.b64encode(b"BEGIN:VCALENDAR").decode(), "ContentType": "text/calendar"},
                {"Name": "factuur.pdf", "Content": _PDF_B64, "ContentType": 'application/pdf; name="factuur.pdf"'},
                {"Name": "logo.png", "Content": base64.b64encode(b"\x89PNG").decode(), "ContentType": "image/png"},
            ],
        },
        auth=AUTH,
    )
    assert response.status_code == 200
    row = store["inbound_email_queue"]["rows"][0]
    assert row["attachment_name"] == "factuur.pdf"
    # The ContentType's `; name=` parameter must be stripped — Gemini rejects it as a mime type.
    assert row["attachment_mime_type"] == "application/pdf"
    assert row["attachment_content"] == _PDF_B64


def test_inbound_email_skips_an_oversized_attachment():
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {})
    huge = base64.b64encode(b"x" * (email_bill_router._MAX_ATTACHMENT_BYTES + 1)).decode()
    client.post(
        "/inbound-email",
        json={
            "MessageID": "att2",
            "Subject": "bill",
            "TextBody": "see attached",
            "OriginalRecipient": "abc123@inbox.invfin.app",
            "Attachments": [{"Name": "huge.pdf", "Content": huge, "ContentType": "application/pdf"}],
        },
        auth=AUTH,
    )
    row = store["inbound_email_queue"]["rows"][0]
    assert row["attachment_content"] is None


def test_attachment_bill_is_detected_when_the_body_text_has_no_numbers(monkeypatch):
    # The headline case. Body-only classification says "not a bill" (correctly — there is nothing
    # payable in that text); the attachment is what makes it one.
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {"create_detected_bill": "bill-pdf-1"})
    calls = _recording_detection(
        monkeypatch,
        classify=lambda _s, _b, document: ClassifyResult(
            is_bill=document is not None, confidence=0.95 if document is not None else 0.1
        ),
        extract=lambda _s, _b, _document: _bill_result(),
    )

    response = client.post(
        "/inbound-email",
        json={
            "MessageID": "att3",
            "Subject": "Contributie - factuur 40023635",
            "TextBody": "Beste lid,\n\nHierbij ontvangt u een factuur.",
            "OriginalRecipient": "abc123@inbox.invfin.app",
            "Attachments": [{"Name": "factuur.pdf", "Content": _PDF_B64, "ContentType": "application/pdf"}],
        },
        auth=AUTH,
    )
    assert response.json()["status"] == "queued"

    # Cheap body-only call first, then the attachment call — never the attachment first.
    assert calls["classify"][0] is None
    assert calls["classify"][1].mime_type == "application/pdf"
    assert calls["classify"][1].data == _PDF_BYTES
    # Extraction saw the document too, otherwise it would have nothing to read the amount from.
    assert calls["extract"][0].data == _PDF_BYTES

    notification = next(n for n in store["notifications"]["inserts"] if n["type"] == "bill_detected")
    assert notification["related_bill_id"] == "bill-pdf-1"
    assert store["inbound_email_queue"]["rows"][0]["status"] == "done"


def test_body_text_bill_never_pays_for_an_attachment_call(monkeypatch):
    # Attachment parsing is a fallback, not always-on: an email whose body already classifies and
    # extracts cleanly must cost exactly the two text calls it cost before this feature existed.
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {"create_detected_bill": "bill-body-1"})
    calls = _recording_detection(
        monkeypatch,
        classify=lambda _s, _b, _document: ClassifyResult(is_bill=True, confidence=0.95),
        extract=lambda _s, _b, _document: _bill_result(vendor="British Gas", currency="GBP"),
    )

    client.post(
        "/inbound-email",
        json={
            "MessageID": "att4",
            "Subject": "Your British Gas bill",
            "TextBody": "Amount due: GBP 61.40. Due date: 2026-10-15.",
            "OriginalRecipient": "abc123@inbox.invfin.app",
            "Attachments": [{"Name": "bill.pdf", "Content": _PDF_B64, "ContentType": "application/pdf"}],
        },
        auth=AUTH,
    )
    assert calls["classify"] == [None]
    assert calls["extract"] == [None]


def test_attachment_is_retried_when_body_text_extraction_fails(monkeypatch):
    # Classifier confident from the body (it names a vendor and says a payment is due), but the
    # body has no amount, so the text-only extraction can't produce a bill. The PDF is the retry.
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {"create_detected_bill": "bill-retry-1"})

    def _extract(_subject, _body, document):
        if document is None:
            raise BillExtractionFailed("no amount in the body text")
        return _bill_result(vendor="Vattenfall Energie")

    calls = _recording_detection(
        monkeypatch,
        classify=lambda _s, _b, _document: ClassifyResult(is_bill=True, confidence=0.9),
        extract=_extract,
    )

    client.post(
        "/inbound-email",
        json={
            "MessageID": "att5",
            "Subject": "Rechnung von Vattenfall",
            "TextBody": "Ihre Rechnung finden Sie im Anhang.",
            "OriginalRecipient": "abc123@inbox.invfin.app",
            "Attachments": [{"Name": "rechnung.pdf", "Content": _PDF_B64, "ContentType": "application/pdf"}],
        },
        auth=AUTH,
    )
    assert calls["extract"][0] is None
    assert calls["extract"][1].data == _PDF_BYTES
    assert store["inbound_email_queue"]["rows"][0]["status"] == "done"


def test_non_bill_with_no_attachment_still_produces_nothing(monkeypatch):
    # Regression guard for the path that already worked: a newsletter with no attachment must not
    # start producing bills now that a fallback exists.
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {"create_detected_bill": "should-not-be-created"})
    calls = _recording_detection(
        monkeypatch,
        classify=lambda _s, _b, _document: ClassifyResult(is_bill=False, confidence=0.98),
        extract=lambda _s, _b, _document: _bill_result(),
    )

    client.post(
        "/inbound-email",
        json={
            "MessageID": "att6",
            "Subject": "Your weekly newsletter",
            "TextBody": "Here is what happened this week.",
            "OriginalRecipient": "abc123@inbox.invfin.app",
        },
        auth=AUTH,
    )
    assert calls["classify"] == [None]
    assert calls["extract"] == []
    assert store["inbound_email_queue"]["rows"][0]["status"] == "done"
    assert "notifications" not in store


def test_non_bill_with_an_attachment_still_produces_nothing(monkeypatch):
    # A receipt or a shipping notice WITH a PDF attached must still be rejected — the fallback
    # exists to read a bill that's in an attachment, not to turn every attachment into a bill.
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, _ = _build_app(store, {"create_detected_bill": "should-not-be-created"})
    calls = _recording_detection(
        monkeypatch,
        classify=lambda _s, _b, _document: ClassifyResult(is_bill=False, confidence=0.96),
        extract=lambda _s, _b, _document: _bill_result(),
    )

    client.post(
        "/inbound-email",
        json={
            "MessageID": "att7",
            "Subject": "Your receipt from Acme",
            "TextBody": "Thanks for your payment. Receipt attached.",
            "OriginalRecipient": "abc123@inbox.invfin.app",
            "Attachments": [{"Name": "receipt.pdf", "Content": _PDF_B64, "ContentType": "application/pdf"}],
        },
        auth=AUTH,
    )
    # Both classify calls ran (body, then attachment) and both said no — so nothing was extracted.
    assert calls["classify"][0] is None
    assert calls["classify"][1].data == _PDF_BYTES
    assert calls["extract"] == []
    assert "notifications" not in store


# --- "Check for new bills" ----------------------------------------------------------------------


def test_check_new_bills_rejects_invalid_session():
    client, _ = _build_app({}, {})
    response = client.post("/check-new-bills", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401


def test_check_new_bills_reports_zero_when_there_is_nothing_outstanding():
    # The honest empty case: the button must report nothing rather than manufacture something.
    client, _ = _build_app({"inbound_email_queue": {"rows": [], "inserts": []}}, {})
    response = client.post("/check-new-bills", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 200
    assert response.json() == {"checked": 0, "bills_detected": 0}


def test_check_new_bills_processes_only_the_callers_own_queued_email(monkeypatch):
    store = {
        "inbound_email_queue": {
            "rows": [
                {"id": "q1", "user_id": "u1", "subject": "Facture Veolia", "body_text": "Montant: 48,20 EUR", "message_id": "mine", "status": "pending", "attempts": 0},
                {"id": "q2", "user_id": "someone-else", "subject": "Factura", "body_text": "Importe: 30 EUR", "message_id": "theirs", "status": "pending", "attempts": 0},
            ],
            "inserts": [],
        }
    }
    client, _ = _build_app(store, {"create_detected_bill": "bill-checked-1"})
    _recording_detection(
        monkeypatch,
        classify=lambda _s, _b, _document: ClassifyResult(is_bill=True, confidence=0.95),
        extract=lambda _s, _b, _document: _bill_result(vendor="Veolia Eau"),
    )

    response = client.post("/check-new-bills", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 200
    assert response.json() == {"checked": 1, "bills_detected": 1}

    rows = {r["id"]: r for r in store["inbound_email_queue"]["rows"]}
    assert rows["q1"]["status"] == "done"
    # The other tenant's row was never claimed, so its attempt count is untouched.
    assert rows["q2"]["status"] == "pending"
    assert rows["q2"]["attempts"] == 0


# --- /run-reminder-check ------------------------------------------------------------------------
# Timing arithmetic itself lives in test_reminder_scheduling.py; these cover the sweep's wiring:
# which rows it looks at, that it claims before notifying, and that it never fires twice.


def _bill_row(**overrides):
    row = {
        "id": "b1",
        "user_id": "u1",
        "vendor_name": "British Gas",
        "status": "unpaid",
        "due_date": None,
        "reminder_mode": "offset",
        "reminder_offset_value": 2,
        "reminder_offset_unit": "days",
        "reminder_at": None,
        "reminder_sent_at": None,
    }
    row.update(overrides)
    return row


def _past_instant() -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()


def _future_instant() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()


def test_run_reminder_check_rejects_missing_auth():
    client, _ = _build_app({}, {})
    assert client.post("/run-reminder-check").status_code == 401


def test_run_reminder_check_fires_an_exact_reminder_whose_instant_has_passed():
    store = {"bills": {"rows": [_bill_row(reminder_mode="exact", reminder_at=_past_instant())], "inserts": []}}
    client, _ = _build_app(store, {})

    response = client.post("/run-reminder-check", auth=AUTH)
    assert response.status_code == 200
    assert response.json() == {"checked": 1, "reminders_sent": 1, "skipped": 0}
    assert store["bills"]["rows"][0]["reminder_sent_at"] is not None
    assert len(store["notifications"]["inserts"]) == 1


def test_run_reminder_check_leaves_a_future_exact_reminder_alone():
    store = {"bills": {"rows": [_bill_row(reminder_mode="exact", reminder_at=_future_instant())], "inserts": []}}
    client, _ = _build_app(store, {})

    assert client.post("/run-reminder-check", auth=AUTH).json() == {"checked": 1, "reminders_sent": 0, "skipped": 0}
    assert store["bills"]["rows"][0]["reminder_sent_at"] is None
    assert "notifications" not in store


def test_run_reminder_check_never_fires_the_same_bill_twice():
    # The sweep runs every 5 minutes now, so this is the difference between one reminder and 288 of
    # them a day. Two back-to-back invocations stand in for two consecutive sweeps.
    store = {"bills": {"rows": [_bill_row(reminder_mode="exact", reminder_at=_past_instant())], "inserts": []}}
    client, _ = _build_app(store, {})

    assert client.post("/run-reminder-check", auth=AUTH).json()["reminders_sent"] == 1
    second = client.post("/run-reminder-check", auth=AUTH).json()
    # Already-claimed rows are excluded by the query's `reminder_sent_at is null` filter, so the
    # second sweep does not even consider it.
    assert second == {"checked": 0, "reminders_sent": 0, "skipped": 0}
    assert len(store["notifications"]["inserts"]) == 1


def test_run_reminder_check_skips_an_offset_bill_with_no_due_date():
    store = {"bills": {"rows": [_bill_row(due_date=None)], "inserts": []}}
    client, _ = _build_app(store, {})

    assert client.post("/run-reminder-check", auth=AUTH).json() == {"checked": 1, "reminders_sent": 0, "skipped": 0}
    assert store["bills"]["rows"][0]["reminder_sent_at"] is None


def test_run_reminder_check_does_not_backfill_a_long_past_due_date():
    # Without the grace window, switching from "== today" to ">= remind_at" would make the first
    # sweep after deploy notify about every historical unpaid bill at once.
    store = {"bills": {"rows": [_bill_row(due_date="2020-01-15")], "inserts": []}}
    client, _ = _build_app(store, {})

    assert client.post("/run-reminder-check", auth=AUTH).json()["reminders_sent"] == 0
    assert store["bills"]["rows"][0]["reminder_sent_at"] is None


def test_run_reminder_check_body_works_when_an_exact_bill_has_no_due_date():
    store = {"bills": {"rows": [_bill_row(reminder_mode="exact", reminder_at=_past_instant(), due_date=None)], "inserts": []}}
    client, _ = _build_app(store, {})

    client.post("/run-reminder-check", auth=AUTH)
    body = store["notifications"]["inserts"][0]["body"]
    assert "None" not in body
    assert "British Gas" in body
