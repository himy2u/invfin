import json

from google import genai
from google.genai import errors as genai_errors
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from invoice_scan import InvoiceScanResult, LineItemDraft, _strip_markdown_fence
from logging_setup import logger

NL_PROMPT = """Parse this natural-language invoice request into JSON matching this exact shape,
no other text, no markdown fences:
{{
  "client_name": string,
  "line_items": [{{"description": string, "quantity": number, "unit_price": number}}],
  "tax_rate_percent": number
}}
Infer quantity as 1 if not stated. "tax_rate_percent" is the tax rate as a plain number (8 for
"8% tax"), 0 if no tax is mentioned — return the rate itself, not a computed dollar amount, that
math is done separately. If the amount or client is genuinely ambiguous, use your best reading
rather than refusing — the user reviews and edits every field before anything is saved, so a
reasonable guess beats an empty field.

Request: {text}"""


@retry(
    retry=retry_if_exception_type(genai_errors.ServerError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    reraise=True,
)
def _generate_with_retry(client: genai.Client, text: str):
    return client.models.generate_content(model="gemini-3.5-flash-lite", contents=NL_PROMPT.format(text=text))


def parse_invoice_text(text: str, api_key: str) -> InvoiceScanResult:
    client = genai.Client(api_key=api_key)
    response = _generate_with_retry(client, text)

    raw = _strip_markdown_fence(response.text or "{}")
    data = json.loads(raw)

    line_items = [LineItemDraft(**item) for item in data.get("line_items", [])]
    line_items_sum = sum(item.quantity * item.unit_price for item in line_items)

    # Tax is computed deterministically from the rate the model extracts, not trusted as a
    # model-computed dollar amount — LLM arithmetic on percentages is exactly the kind of thing
    # that should be cross-checked, not taken on faith (same principle as the scan validator).
    tax_rate_percent = data.get("tax_rate_percent") or 0
    tax = round(line_items_sum * tax_rate_percent / 100, 2)

    logger.info("parsed invoice from natural language", client_name=data.get("client_name"))

    # No "total" to cross-check against here — unlike a scanned document, there's no independently
    # printed total to validate the line items against, so total_matches_line_items is trivially
    # true. The line items themselves are the only thing to review before saving.
    return InvoiceScanResult(
        document_type=None,
        vendor=None,
        client_name=data.get("client_name"),
        invoice_number=None,
        reference_number=None,
        date=None,
        line_items=line_items,
        tax=tax,
        total=round(line_items_sum + tax, 2),
        line_items_sum=round(line_items_sum, 2),
        total_matches_line_items=True,
    )
