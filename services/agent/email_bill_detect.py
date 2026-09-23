import json
import re

from google import genai
from google.genai import errors as genai_errors
from pydantic import BaseModel, ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from logging_setup import logger

# A cheap/fast classification pass BEFORE the full extraction call. Receipts, shipping
# confirmations, bank/card statements, and newsletters all superficially pattern-match "a bill" —
# and once a user sets a broad Gmail filter (e.g. "forward anything with 'invoice' in the subject"),
# every one of those false positives becomes a row in their bills table. Classifying first with a
# conservative threshold, and only running the (more expensive, more literal) extraction prompt
# when the classifier is confident, keeps that noise out without hand-rolling regex heuristics that
# would need constant tuning.
_CLASSIFY_PROMPT = """You will be shown the subject and body text of an email. Decide whether this
email is a BILL — a specific, actionable request for the recipient to pay a specific vendor a
specific amount by a specific due date (e.g. a utility bill, a SaaS invoice, a phone bill, an EMI/loan
payment notice). It must contain a concrete amount and, ideally, a due date.

It is NOT a bill if it's a receipt for a purchase already completed, a payment confirmation, a bank
or credit card statement, a shipping/delivery notification, a marketing email, a newsletter, or a
generic "your invoice is attached" email with no amount/due date actually visible in the text.

Respond with JSON only, no markdown fences: {"is_bill": boolean, "confidence": number between 0 and 1}
"""

_EXTRACT_PROMPT = """This email is a bill the recipient needs to pay. Extract data as JSON matching
this exact shape, no other text, no markdown fences:
{
  "vendor_name": string,
  "vendor_address": string | null,
  "vendor_email": string | null,
  "currency": string (3-letter ISO code, e.g. "USD"),
  "issue_date": string (YYYY-MM-DD) | null,
  "due_date": string (YYYY-MM-DD),
  "line_items": [{"description": string, "quantity": number, "unit_price": number}]
}
If no line items are itemized, use a single line item with description "Amount due" and the total
as unit_price with quantity 1. due_date is required — if genuinely no due date is printed anywhere,
this email should not have reached this step; make your best reading of any date described as "due,"
"pay by," or similar. Use raw numbers for money, no currency symbols."""

# Confidence threshold is deliberately conservative — a false negative (a real bill not detected)
# costs the user nothing beyond needing to enter it manually, same as today. A false positive
# (junk turned into a "pending review" bill) corrodes trust in the review queue and, if enough
# accumulate, trains the user to stop looking at it — which is worse than never having the review
# queue at all.
CLASSIFY_CONFIDENCE_THRESHOLD = 0.7

# Gmail's real forwarding-confirmation email (verified against two live messages, 2026-09-23) is a
# clickable link, not a typed code — there is no "confirmation code" text anywhere in it. Gmail
# uses more than one host for this link (mail-settings.google.com in one message, mail.google.com
# in another, from the same account within minutes) so this matches the host loosely rather than
# pinning one. The path always starts with /mail/vf- (the cancel link alongside it uses /mail/uf-,
# which must NOT match here or the wizard would hand the user a link that undoes the request).
_GMAIL_CONFIRMATION_LINK_RE = re.compile(r"https://mail[a-z.-]*\.google\.com/mail/vf-\S+")


class ClassifyResult(BaseModel):
    is_bill: bool
    confidence: float


class LineItemDraft(BaseModel):
    description: str
    quantity: float
    unit_price: float


class BillExtractionResult(BaseModel):
    vendor_name: str
    vendor_address: str | None = None
    vendor_email: str | None = None
    currency: str
    issue_date: str | None = None
    due_date: str
    line_items: list[LineItemDraft]


class BillExtractionFailed(Exception):
    # Raised when Gemini's output doesn't parse as the expected shape (truncated response, a date
    # that isn't ISO, a missing required field). Distinct from a plain classify/extract call
    # succeeding with "not a bill" — that's a clean, expected outcome; this is the model producing
    # garbage. The router catches this specifically to notify the user "we couldn't read that
    # bill" instead of surfacing a generic 502 that just makes Postmark retry (burning another
    # Gemini call) until it gives up with the user never told anything happened.
    pass


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
def _generate_with_retry(client: genai.Client, prompt: str, text: str):
    return client.models.generate_content(model="gemini-3.5-flash-lite", contents=[text, prompt])


def classify_bill_email(api_key: str, subject: str, body_text: str) -> ClassifyResult:
    client = genai.Client(api_key=api_key)
    text = f"Subject: {subject}\n\n{body_text}"
    response = _generate_with_retry(client, _CLASSIFY_PROMPT, text)
    try:
        data = json.loads(_strip_markdown_fence(response.text or "{}"))
        result = ClassifyResult(**data)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise BillExtractionFailed(f"classification output did not parse: {exc}") from exc
    logger.info("bill email classified", is_bill=result.is_bill, confidence=result.confidence)
    return result


def extract_bill_from_email(api_key: str, subject: str, body_text: str) -> BillExtractionResult:
    client = genai.Client(api_key=api_key)
    text = f"Subject: {subject}\n\n{body_text}"
    response = _generate_with_retry(client, _EXTRACT_PROMPT, text)
    try:
        data = json.loads(_strip_markdown_fence(response.text or "{}"))
        return BillExtractionResult(**data)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise BillExtractionFailed(f"extraction output did not parse: {exc}") from exc


def detect_gmail_confirmation_link(subject: str, body_text: str) -> str | None:
    # Special-cased rather than run through the general classifier/extractor: this is Gmail's own
    # transactional "confirm this forwarding address" email, structurally identical every time, and
    # the ONLY way the user ever sees this link (they have no inbox at the generated forwarding
    # address to open it in themselves — this webhook catching it and relaying it in-app is the
    # entire mechanism). A regex on a fixed template is more reliable here than an LLM call, and
    # doesn't depend on GEMINI_API_KEY / network being up for something this basic.
    if "forwarding" not in subject.lower() and "forwarding" not in body_text.lower():
        return None
    match = _GMAIL_CONFIRMATION_LINK_RE.search(body_text)
    return match.group(0) if match else None
