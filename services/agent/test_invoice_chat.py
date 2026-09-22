import os

import pytest

from invoice_chat import ChatMessage, InvoiceDraft, chat_invoice_turn

pytestmark = pytest.mark.skipif(not os.environ.get("GEMINI_API_KEY"), reason="requires a real Gemini API key")


def test_first_turn_extracts_client_and_line_item() -> None:
    result = chat_invoice_turn(
        [ChatMessage(role="user", content="bill Acme Corp $500 for design work")],
        draft=None,
    )
    assert result.draft.client_name == "Acme Corp"
    assert len(result.draft.line_items) == 1
    assert result.draft.line_items[0].unit_price == 500
    assert result.ready is True


def test_second_turn_carries_forward_prior_draft_fields() -> None:
    prior_draft = InvoiceDraft(
        client_name="Acme Corp",
        line_items=[{"description": "design work", "quantity": 1, "unit_price": 500}],
    )
    result = chat_invoice_turn(
        [
            ChatMessage(role="user", content="bill Acme Corp $500 for design work"),
            ChatMessage(role="assistant", content="Added it. Email or due date?"),
            ChatMessage(role="user", content="their email is ap@acme.com"),
        ],
        draft=prior_draft,
    )
    # The line item from the first turn must survive even though this message never mentioned it —
    # a stateless model call re-sent the whole draft precisely so it wouldn't get dropped.
    assert result.draft.client_name == "Acme Corp"
    assert len(result.draft.line_items) == 1
    assert result.draft.client_email == "ap@acme.com"
