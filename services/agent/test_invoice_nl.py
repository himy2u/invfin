import os

import pytest

from invoice_nl import parse_invoice_text


@pytest.mark.skipif(not os.environ.get("GEMINI_API_KEY"), reason="no GEMINI_API_KEY set")
def test_parse_invoice_text_multiple_line_items() -> None:
    result = parse_invoice_text(
        "bill Acme Corp $500 for design work, plus $150 for a follow-up consulting call",
        os.environ["GEMINI_API_KEY"],
    )
    assert result.client_name == "Acme Corp"
    assert len(result.line_items) == 2
    assert result.total == 650.0


@pytest.mark.skipif(not os.environ.get("GEMINI_API_KEY"), reason="no GEMINI_API_KEY set")
def test_parse_invoice_text_tax_rate_computed_not_literal() -> None:
    # Regression test: the model must not treat "8% tax" as a literal $0.08 — tax has to be
    # computed as a percentage of the line items, done deterministically in Python, not by the LLM.
    result = parse_invoice_text(
        "invoice Sarah for 3 hours of consulting at $150/hr, 8% tax",
        os.environ["GEMINI_API_KEY"],
    )
    assert result.line_items_sum == 450.0
    assert result.tax == 36.0
    assert result.total == 486.0
