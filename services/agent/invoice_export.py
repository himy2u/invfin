import csv
import io
from xml.sax.saxutils import escape

from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


class PartyInfo(BaseModel):
    name: str | None = None
    address: str | None = None
    email: str | None = None
    phone: str | None = None
    tax_registration_number: str | None = None


class ExportLineItem(BaseModel):
    description: str
    quantity: float
    unit_price_cents: int
    tax_rate_percent: float
    tax_label: str


class InvoiceExportRequest(BaseModel):
    invoice_number: str
    currency: str
    issue_date: str
    due_date: str | None = None
    terms: str | None = None
    status: str
    subtotal_cents: int
    tax_cents: int
    total_cents: int
    business: PartyInfo
    client: PartyInfo
    line_items: list[ExportLineItem]


def _money(cents: int, currency: str) -> str:
    return f"{cents / 100:.2f} {currency}"


def generate_invoice_pdf(data: InvoiceExportRequest) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=0.75 * inch, bottomMargin=0.75 * inch)
    styles = getSampleStyleSheet()
    story = []

    title_style = ParagraphStyle("InvoiceTitle", parent=styles["Heading1"], fontSize=20)
    story.append(Paragraph(f"Invoice {escape(data.invoice_number)}", title_style))
    story.append(Spacer(1, 4))
    story.append(Paragraph(f"Status: {data.status} · Issued: {data.issue_date}", styles["Normal"]))
    if data.due_date:
        story.append(Paragraph(f"Due: {data.due_date}", styles["Normal"]))
    story.append(Spacer(1, 16))

    def party_block(label: str, party: PartyInfo) -> list:
        # ReportLab's Paragraph parses a mini XML/HTML subset — any unescaped "<"/">"/"&" in a
        # client's name, address, or terms (e.g. "Bob <Smith>", "Net 30 & due <urgent>") is parsed
        # as markup and silently dropped rather than raising, so an invoice can ship to the actual
        # customer missing part of their own name with no error anywhere. Every user-controlled
        # string must be escaped before being concatenated into a Paragraph's XML string; only the
        # "<br/>" we insert ourselves is real markup and must NOT be escaped.
        lines = [f"<b>{escape(label)}</b>", escape(party.name) if party.name else "—"]
        if party.address:
            lines.append(escape(party.address).replace("\n", "<br/>"))
        if party.email:
            lines.append(escape(party.email))
        if party.phone and not party.email:
            lines.append(escape(party.phone))
        if party.tax_registration_number:
            lines.append(f"Tax ID: {escape(party.tax_registration_number)}")
        return [Paragraph("<br/>".join(lines), styles["Normal"])]

    party_table = Table(
        [[party_block("From", data.business), party_block("Bill to", data.client)]],
        colWidths=[3.25 * inch, 3.25 * inch],
    )
    party_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(party_table)
    story.append(Spacer(1, 20))

    header = ["Description", "Qty", "Rate", "Tax", "Amount"]
    rows = [header]
    for item in data.line_items:
        amount = item.quantity * item.unit_price_cents
        # Table cells here are plain strings, not Paragraph objects — ReportLab's Table draws them
        # literally rather than parsing markup, so escaping would show a literal "&lt;" to the
        # reader instead of "<". Only text passed to Paragraph() (title, party_block, Terms below)
        # goes through the mini-XML parser and needs escaping.
        tax_display = f"{item.tax_label} {item.tax_rate_percent:g}%" if item.tax_rate_percent > 0 else "—"
        rows.append(
            [
                item.description,
                f"{item.quantity:g}",
                _money(item.unit_price_cents, data.currency),
                tax_display,
                _money(amount, data.currency),
            ]
        )

    line_table = Table(rows, colWidths=[2.5 * inch, 0.7 * inch, 1.1 * inch, 1.3 * inch, 1.15 * inch])
    line_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f4f4f5")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#71717a")),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e4e4e7")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(line_table)
    story.append(Spacer(1, 12))

    totals_rows = [
        ["Subtotal", _money(data.subtotal_cents, data.currency)],
        ["Tax", _money(data.tax_cents, data.currency)],
        ["Total", _money(data.total_cents, data.currency)],
    ]
    totals_table = Table(totals_rows, colWidths=[5.65 * inch, 1.1 * inch])
    totals_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("LINEABOVE", (0, -1), (-1, -1), 0.75, colors.HexColor("#3f3f46")),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(totals_table)

    if data.terms:
        story.append(Spacer(1, 20))
        story.append(Paragraph(f"<b>Terms:</b> {escape(data.terms)}", styles["Normal"]))

    doc.build(story)
    return buffer.getvalue()


_FORMULA_LEAD_CHARS = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: str) -> str:
    # CSV formula injection (CWE-1236): Excel/Sheets treats a cell beginning with =, +, -, or @ as
    # a formula when the file is opened. The scan-CSV path in main.py ingests untrusted external
    # documents, so a description field alone (not just this app's own users) can carry a leading
    # "=" straight into an exported file. Prefixing with a single quote forces spreadsheet apps to
    # treat it as literal text without changing what's displayed.
    if value and value[0] in _FORMULA_LEAD_CHARS:
        return f"'{value}"
    return value


def generate_invoice_csv(data: InvoiceExportRequest) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Invoice", data.invoice_number, "Status", data.status, "Issued", data.issue_date])
    writer.writerow(["From", _csv_safe(data.business.name or "")])
    writer.writerow(["Bill to", _csv_safe(data.client.name or ""), _csv_safe(data.client.email or data.client.phone or "")])
    writer.writerow([])
    writer.writerow(["Description", "Qty", "Rate", "Tax name", "Tax %", "Amount"])
    for item in data.line_items:
        amount = item.quantity * item.unit_price_cents
        writer.writerow(
            [
                _csv_safe(item.description),
                item.quantity,
                item.unit_price_cents / 100,
                _csv_safe(item.tax_label),
                item.tax_rate_percent,
                amount / 100,
            ]
        )
    writer.writerow([])
    writer.writerow(["Subtotal", data.subtotal_cents / 100])
    writer.writerow(["Tax", data.tax_cents / 100])
    writer.writerow(["Total", data.total_cents / 100])
    return buffer.getvalue()
