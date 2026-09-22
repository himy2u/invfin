import json
import os

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from logging_setup import logger

EXTRACTION_PROMPT = """This document is a business document — an invoice, receipt, purchase order, or
timesheet. Extract data as JSON matching this exact shape, no other text, no markdown fences:
{
  "document_type": "invoice" | "receipt" | "purchase_order" | "timesheet",
  "vendor": string,
  "vendor_address": string,
  "client_name": string,
  "client_address": string,
  "client_email": string,
  "client_phone": string,
  "invoice_number": string,
  "reference_number": string,
  "date": string (YYYY-MM-DD),
  "line_items": [{"description": string, "quantity": number, "unit_price": number}],
  "tax": number,
  "total": number
}
"vendor" is whoever issued/is billing the document (the business itself on a timesheet). "client_name"
/"client_address"/"client_email"/"client_phone" are the customer being billed ("Bill To") — pull the
address, email, and phone directly from the document when printed there (a "Bill To" block, letterhead,
footer, etc.); leave any of them null if genuinely not present rather than guessing.
If this is a purchase order, "reference_number" is the PO number (what a resulting invoice should
cite), and "invoice_number" should be null. If this is an invoice or receipt, "reference_number" is
null. If this is a timesheet, each line_item is one row of logged time — "description" is the
task/date/period for that row (e.g. "Week 1: 3-Mar to 8-Mar"). Timesheets commonly print TWO hour
columns per row — a per-day rate (e.g. "Daily Hours: 7.50") and a period total (e.g. "Total Hours
Billed: 30.00"); "quantity" must be the PERIOD TOTAL column, never the per-day figure — the per-day
number is not what gets billed and using it would undercount the invoice by roughly a factor of the
number of days worked. If only one hours column exists, use that. If no rate is printed on the
timesheet, set "unit_price" to 0 (the user fills in the rate manually — better than guessing a
dollar figure that isn't actually on the document). Timesheets usually have no printed total; leave
"total" null rather than computing one yourself.
"tax" is the tax/VAT amount shown, as a raw number (0 if none shown). "total" is the final amount,
which should equal the sum of line items plus tax minus any discount, when one is actually printed.
If a field can't be read, use null. Use raw numbers for money, not currency symbols."""


class LineItemDraft(BaseModel):
    description: str
    quantity: float
    unit_price: float


class InvoiceScanResult(BaseModel):
    document_type: str | None
    vendor: str | None
    vendor_address: str | None = None
    client_name: str | None
    client_address: str | None = None
    client_email: str | None = None
    client_phone: str | None = None
    invoice_number: str | None
    reference_number: str | None
    date: str | None
    line_items: list[LineItemDraft]
    tax: float
    total: float | None
    line_items_sum: float
    total_matches_line_items: bool


def _strip_markdown_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]
    return text.strip()


@retry(
    retry=retry_if_exception_type(genai_errors.ServerError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    reraise=True,
)
def _generate_with_retry(client: genai.Client, contents: list):
    return client.models.generate_content(model="gemini-3.5-flash-lite", contents=contents)


def _result_from_json(data: dict) -> InvoiceScanResult:
    line_items = [LineItemDraft(**item) for item in data.get("line_items", [])]
    line_items_sum = sum(item.quantity * item.unit_price for item in line_items)
    tax = data.get("tax") or 0
    total = data.get("total")

    # Vision/text models can hallucinate numbers in ambiguous corners of a document —
    # cross-checking the extracted total against line_items + tax catches that without a second
    # model call. Comparing against line items alone (without tax) produces false positives on
    # every taxed invoice. A document type with no printed total at all (timesheets) isn't a
    # "mismatch" — there's nothing to contradict, so it stays true rather than triggering a false
    # warning every time.
    expected_total = line_items_sum + tax
    total_matches = total is None or abs(expected_total - total) < 0.01

    if not total_matches:
        logger.warning(
            "invoice scan total mismatch",
            extracted_total=total,
            line_items_sum=line_items_sum,
            tax=tax,
            expected_total=expected_total,
        )

    return InvoiceScanResult(
        document_type=data.get("document_type"),
        vendor=data.get("vendor"),
        vendor_address=data.get("vendor_address"),
        client_name=data.get("client_name"),
        client_address=data.get("client_address"),
        client_email=data.get("client_email"),
        client_phone=data.get("client_phone"),
        invoice_number=data.get("invoice_number"),
        reference_number=data.get("reference_number"),
        date=data.get("date"),
        line_items=line_items,
        tax=tax,
        total=total,
        line_items_sum=round(line_items_sum, 2),
        total_matches_line_items=total_matches,
    )


def scan_invoice_image(image_bytes: bytes, mime_type: str) -> InvoiceScanResult:
    api_key = os.environ["GEMINI_API_KEY"]
    client = genai.Client(api_key=api_key)

    # Gemini's API returns transient 503s under load (observed in practice, not hypothetical) —
    # retry with backoff instead of failing a scan outright on a momentary blip.
    response = _generate_with_retry(
        client, [types.Part.from_bytes(data=image_bytes, mime_type=mime_type), EXTRACTION_PROMPT]
    )
    return _result_from_json(json.loads(_strip_markdown_fence(response.text or "{}")))


def scan_invoice_csv(csv_text: str) -> InvoiceScanResult:
    # A CSV export of a timesheet/invoice (e.g. a Google Sheets download) carries the same
    # ambiguous "daily hours vs. period total" column pair as the PDF/image version — sending the
    # raw text through the identical extraction prompt (rather than hand-rolling a column-position
    # parser) means one set of column-labeling rules covers both input shapes.
    api_key = os.environ["GEMINI_API_KEY"]
    client = genai.Client(api_key=api_key)
    response = _generate_with_retry(client, [f"CSV contents:\n\n{csv_text}", EXTRACTION_PROMPT])
    return _result_from_json(json.loads(_strip_markdown_fence(response.text or "{}")))
