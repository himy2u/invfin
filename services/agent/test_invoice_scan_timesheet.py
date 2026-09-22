from invoice_scan import InvoiceScanResult, LineItemDraft


def _build_result(total: float | None, tax: float, line_items: list[LineItemDraft]) -> InvoiceScanResult:
    line_items_sum = sum(item.quantity * item.unit_price for item in line_items)
    expected_total = line_items_sum + tax
    total_matches = total is None or abs(expected_total - total) < 0.01
    return InvoiceScanResult(
        document_type="timesheet",
        vendor=None,
        client_name=None,
        invoice_number=None,
        reference_number=None,
        date=None,
        line_items=line_items,
        tax=tax,
        total=total,
        line_items_sum=round(line_items_sum, 2),
        total_matches_line_items=total_matches,
    )


def test_timesheet_with_no_printed_total_is_not_flagged_as_mismatch() -> None:
    # Regression: a timesheet legitimately has no total to check against — this must not produce
    # a false "total didn't match" warning the way a real invoice mismatch would.
    result = _build_result(
        total=None,
        tax=0,
        line_items=[LineItemDraft(description="Week 1", quantity=30, unit_price=0)],
    )
    assert result.total_matches_line_items is True


def test_invoice_with_wrong_printed_total_is_still_flagged() -> None:
    result = _build_result(
        total=999,
        tax=0,
        line_items=[LineItemDraft(description="Design", quantity=1, unit_price=500)],
    )
    assert result.total_matches_line_items is False
