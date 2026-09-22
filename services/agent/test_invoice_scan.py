import os

import pytest

from invoice_scan import _strip_markdown_fence, scan_invoice_image


def test_strip_markdown_fence_removes_json_fence() -> None:
    assert _strip_markdown_fence('```json\n{"a": 1}\n```') == '{"a": 1}'


def test_strip_markdown_fence_passthrough_when_no_fence() -> None:
    assert _strip_markdown_fence('{"a": 1}') == '{"a": 1}'


@pytest.mark.skipif(not os.environ.get("GEMINI_API_KEY"), reason="no GEMINI_API_KEY set")
def test_scan_invoice_image_extracts_and_validates_total() -> None:
    with open("tests/fixtures/sample-invoice.png", "rb") as f:
        image_bytes = f.read()

    result = scan_invoice_image(image_bytes, "image/png")

    assert result.vendor == "Bright Design Studio"
    assert result.total == 1350.0
    assert result.total_matches_line_items is True
