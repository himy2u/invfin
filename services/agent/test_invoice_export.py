import subprocess
import tempfile

from invoice_export import ExportLineItem, InvoiceExportRequest, PartyInfo, generate_invoice_csv, generate_invoice_pdf


def _base_request(**overrides) -> InvoiceExportRequest:
    defaults = dict(
        invoice_number="INV-1",
        currency="USD",
        issue_date="2026-09-21",
        status="draft",
        subtotal_cents=1000,
        tax_cents=0,
        total_cents=1000,
        business=PartyInfo(name="My Biz"),
        client=PartyInfo(name="Client"),
        line_items=[
            ExportLineItem(description="Item", quantity=1, unit_price_cents=1000, tax_rate_percent=0, tax_label="Tax")
        ],
    )
    defaults.update(overrides)
    return InvoiceExportRequest(**defaults)


def test_pdf_does_not_truncate_text_containing_angle_brackets() -> None:
    # Regression: ReportLab's Paragraph parses a mini XML/HTML subset — unescaped "<...>" in a
    # client name or terms was silently dropped, shipping a wrong invoice with no error anywhere.
    req = _base_request(
        client=PartyInfo(name="Bob <Smith>"),
        terms="Net 30 & due on receipt <urgent>",
    )
    pdf_bytes = generate_invoice_pdf(req)
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf_bytes)
        f.flush()
        text = subprocess.run(["pdftotext", f.name, "-"], capture_output=True, text=True).stdout

    assert "Bob <Smith>" in text
    assert "Net 30 & due on receipt <urgent>" in text


def test_pdf_line_item_description_is_not_xml_escaped() -> None:
    # Table cells are plain strings (not Paragraph objects) — escaping them would show a literal
    # "&lt;" to the reader instead of "<". Only Paragraph-wrapped text needs escaping.
    req = _base_request(
        line_items=[
            ExportLineItem(description="Design <work>", quantity=1, unit_price_cents=1000, tax_rate_percent=0, tax_label="Tax")
        ]
    )
    pdf_bytes = generate_invoice_pdf(req)
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf_bytes)
        f.flush()
        text = subprocess.run(["pdftotext", f.name, "-"], capture_output=True, text=True).stdout

    assert "Design <work>" in text
    assert "&lt;" not in text


def test_csv_prefixes_formula_leading_characters() -> None:
    # CSV formula injection (CWE-1236): a description beginning with =, +, -, or @ is interpreted
    # as a formula by Excel/Sheets. The scan-CSV path ingests untrusted external documents, so this
    # is reachable from outside this app's own users, not just a theoretical self-inflicted risk.
    req = _base_request(
        line_items=[
            ExportLineItem(
                description="=1+1", quantity=1, unit_price_cents=1000, tax_rate_percent=0, tax_label="Tax"
            )
        ]
    )
    csv_text = generate_invoice_csv(req)
    assert "'=1+1" in csv_text
    assert "\n=1+1" not in csv_text and ",=1+1" not in csv_text
