import os

# Force-set (not setdefault) — these tests assert against a specific username/password pair, so
# they must be hermetic against whatever real value happens to already be loaded into the ambient
# environment (e.g. from the repo's .env.local when running the full suite locally).
os.environ["INBOUND_EMAIL_WEBHOOK_USER"] = "testuser"
os.environ["INBOUND_EMAIL_WEBHOOK_PASSWORD"] = "testpass"
os.environ.setdefault("GEMINI_API_KEY", "unused-in-these-tests")
os.environ.setdefault("EMAIL_FORWARDING_DOMAIN", "inbox.invfin.app")

from fastapi import FastAPI
from fastapi.testclient import TestClient

import email_bill_router
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
        return FakeRpcCall(FakeResult(self.rpc_results.get(name)))

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


def test_send_test_bill_rejects_invalid_session():
    client, _ = _build_app({}, {})
    response = client.post("/send-test-bill", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401


def test_send_test_bill_rejects_when_detection_not_enabled():
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": False}]}}
    client, _ = _build_app(store, {})
    response = client.post("/send-test-bill", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 400


def test_send_test_bill_enqueues_for_the_authenticated_users_own_address():
    store = {"email_forwarding_addresses": {"rows": [{"forwarding_token": "abc123", "user_id": "u1", "enabled": True}]}}
    client, fake_client = _build_app(store, {})
    response = client.post("/send-test-bill", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    queued_row = store["inbound_email_queue"]["inserts"][0]
    assert queued_row["forwarding_token"] == "abc123"
    assert queued_row["user_id"] == "u1"


def test_send_test_reminder_rejects_invalid_session():
    client, _ = _build_app({}, {})
    response = client.post("/send-test-reminder", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401


def test_send_test_reminder_rejects_when_no_detected_bill_yet():
    client, _ = _build_app({}, {})
    response = client.post("/send-test-reminder", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 400


def test_send_test_reminder_sends_without_touching_reminder_sent_at():
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
        }
    }
    client, _ = _build_app(store, {})
    response = client.post("/send-test-reminder", headers={"Authorization": "Bearer valid-user-token"})
    assert response.status_code == 200
    assert response.json() == {"status": "sent", "bill_id": "bill-1"}
    # A test reminder must never mark the real reminder as already sent for this bill.
    assert store["bills"]["rows"][0]["reminder_sent_at"] is None
    notif = store["notifications"]["inserts"][0]
    assert notif["type"] == "bill_reminder"
    assert "Acme Water" in notif["body"]


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
