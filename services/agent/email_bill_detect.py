import json
import re

from dataclasses import dataclass

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
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

# Appended to the prompts above ONLY when an attachment is being sent alongside them, so the
# text-only path's prompt text stays byte-identical to what's already proven in production.
#
# The classifier's base prompt explicitly rejects "a generic 'your invoice is attached' email with
# no amount/due date actually visible in the text" — correct when the attachment is invisible to it,
# and exactly wrong once the attachment is right there in the same request. This override says so
# rather than weakening the base rule, which still has to hold for the text-only call.
_CLASSIFY_ATTACHMENT_NOTE = """

An attachment from this email is included above. Judge the email and its attachment TOGETHER: an
email whose body only says "your invoice is attached" IS a bill when the attached document itself
shows a concrete amount payable. Judge by what the attachment shows, not by the body's silence."""

_EXTRACT_ATTACHMENT_NOTE = """

An attachment from this email is included above and is the authoritative source: read vendor,
amount, currency, issue date and due date from the attached document, and use the email's subject
and body only to fill in what the document doesn't state."""

_EXTRACT_PROMPT = """This email is a bill the recipient needs to pay. Extract data as JSON matching
this exact shape, no other text, no markdown fences:
{
  "vendor_name": string,
  "vendor_address": string | null,
  "vendor_email": string | null,
  "invoice_number": string | null,
  "currency": string (3-letter ISO code, e.g. "USD"),
  "issue_date": string (YYYY-MM-DD) | null,
  "due_date": string (YYYY-MM-DD),
  "stated_total_amount": number | null,
  "line_items": [{"description": string, "quantity": number, "unit_price": number}]
}
If no line items are itemized, use a single line item with description "Amount due" and the total
as unit_price with quantity 1. due_date is required — if genuinely no due date is printed anywhere,
this email should not have reached this step; make your best reading of any date described as "due,"
"pay by," or similar. Use raw numbers for money, no currency symbols.

invoice_number is the vendor's OWN reference for this bill as printed on it (e.g. "Invoice CW-20461"
-> "CW-20461", "Bill #4471" -> "4471"). Null if the document states no such number. Do not invent
one, and do not use an account number, a customer number, or a payment reference as a substitute.

stated_total_amount is the single total payable as literally printed on the bill ("Total due:
$1,248.60" -> 1248.60), null if no total is printed. Give it even when you have also itemized the
line items: it is the cross-check on them.

unit_price is the price of ONE unit, never the line's extended total. For a line reading
"assorted ceramic vases (24) ... 12.50 ... 300.00", quantity is 24 and unit_price is 12.50, NOT
300.00 and NOT 0. quantity x unit_price, summed across every line, must equal
stated_total_amount."""

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


@dataclass(frozen=True)
class BillDocument:
    """One PDF/image attachment off an inbound email, ready to hand to Gemini inline.

    Deliberately not a pydantic model: it holds raw bytes that must never be serialized into a log
    line or an API response, and keeping it a plain frozen dataclass makes that harder to do by
    accident."""

    data: bytes
    mime_type: str


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
    # The vendor's own reference for this bill, when the document states one. Defaulted to None so an
    # older/leaner model response still validates rather than failing the whole extraction over a
    # field that is legitimately absent from most bills.
    invoice_number: str | None = None
    currency: str
    issue_date: str | None = None
    due_date: str
    # The total as literally printed on the bill. Never stored; it exists purely as a cross-check on
    # the line items, which are what the bill's total_cents is actually computed from.
    stated_total_amount: float | None = None
    line_items: list[LineItemDraft]

    def total_cents(self) -> int:
        # Same arithmetic create_detected_bill does in SQL, so what this validates is what gets stored.
        return sum(round(item.quantity * item.unit_price * 100) for item in self.line_items)


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
def _generate_with_retry(client: genai.Client, contents: list):
    return client.models.generate_content(model="gemini-3.5-flash-lite", contents=contents)


def _build_contents(subject: str, body_text: str, prompt: str, note: str, document: BillDocument | None) -> list:
    # The attachment goes FIRST, ahead of the email text, matching how invoice_scan.py orders a
    # document-plus-prompt request (the document these models read best is the one they see before
    # the instructions about it).
    text = f"Subject: {subject}\n\n{body_text}"
    if document is None:
        return [text, prompt]
    return [types.Part.from_bytes(data=document.data, mime_type=document.mime_type), text, prompt + note]


def classify_bill_email(
    api_key: str, subject: str, body_text: str, document: BillDocument | None = None
) -> ClassifyResult:
    client = genai.Client(api_key=api_key)
    response = _generate_with_retry(
        client, _build_contents(subject, body_text, _CLASSIFY_PROMPT, _CLASSIFY_ATTACHMENT_NOTE, document)
    )
    try:
        data = json.loads(_strip_markdown_fence(response.text or "{}"))
        result = ClassifyResult(**data)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise BillExtractionFailed(f"classification output did not parse: {exc}") from exc
    logger.info(
        "bill email classified",
        is_bill=result.is_bill,
        confidence=result.confidence,
        with_attachment=document is not None,
    )
    return result


# Currency amounts as they appear in a real bill email, in either order: a symbol or ISO code before
# the number ("$1,248.60", "USD 1248.60") or after it ("1,248.60 EUR"). Deliberately requires a
# currency marker: a bare "24" from an itemized quantity, an invoice number, or a date fragment must
# not read as money, which is the whole reason this isn't just \d+\.\d\d.
_CURRENCY_CODES = (
    "USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|SEK|NOK|DKK|SGD|HKD|ZAR|AED|BRL|MXN|PLN|CZK|THB|MYR|PHP|IDR"
)
_AMOUNT_RE = re.compile(
    rf"(?:(?:[$€£¥₹]|\b(?:{_CURRENCY_CODES})\b)\s*(?P<pre>\d[\d,]*(?:\.\d{{1,2}})?))"
    rf"|(?:(?P<post>\d[\d,]*(?:\.\d{{1,2}})?)\s*(?:\b(?:{_CURRENCY_CODES})\b|[$€£¥₹]))",
    re.IGNORECASE,
)


def find_currency_amounts(text: str) -> list[float]:
    """Every number in `text` that is unambiguously a currency amount, largest first.

    Not a parser and not trying to be. It exists so that "the extraction produced a zero total" can
    be reported alongside "but the email plainly says 1248.60", which is the difference between a
    diagnosable failure and a silent one.
    """
    found = []
    for match in _AMOUNT_RE.finditer(text):
        raw = match.group("pre") or match.group("post")
        try:
            value = float(raw.replace(",", ""))
        except ValueError:
            continue
        if value > 0:
            found.append(value)
    return sorted(found, reverse=True)


def extract_bill_from_email(
    api_key: str, subject: str, body_text: str, document: BillDocument | None = None
) -> BillExtractionResult:
    client = genai.Client(api_key=api_key)
    response = _generate_with_retry(
        client, _build_contents(subject, body_text, _EXTRACT_PROMPT, _EXTRACT_ATTACHMENT_NOTE, document)
    )
    try:
        data = json.loads(_strip_markdown_fence(response.text or "{}"))
        result = BillExtractionResult(**data)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise BillExtractionFailed(f"extraction output did not parse: {exc}") from exc

    return _validated_total(result, subject, body_text)


def _validated_total(result: BillExtractionResult, subject: str, body_text: str) -> BillExtractionResult:
    """Refuses to return a bill whose total is zero.

    A real forwarded bill with an itemized product list in the body ("assorted ceramic vases (24),
    scented candle sets (60) ... Total due: $1,248.60") came back with the vendor and both dates
    correct and a total of 0.00. Money wrong, everything else right, and nothing on any screen
    suggesting anything had gone wrong. A bill that understates what's owed is worse than no bill at
    all: the user acts on it, pays 0, and finds out from the vendor.

    Two responses, in order of preference:

      * The bill printed a total and the line items don't add up to it at all (they sum to zero).
        Fall back to that printed total as a single line item: itemization is a nicety, the amount
        owed is not. The itemization is lost, which is why this is logged loudly.
      * Nothing usable. Raise BillExtractionFailed, which the queue already retries and then reports
        to the user as "we couldn't read that bill", an outcome they can act on.

    Zero is treated as unconditionally invalid rather than gated on "does the text also contain an
    amount": there is no such thing as a bill for nothing, so no heuristic is needed to know that a
    zero here is a failure. The amount scan still runs, to put the number the email actually showed
    into the log next to the zero we computed.
    """
    total = result.total_cents()
    stated = result.stated_total_amount

    if total > 0:
        if stated and abs(stated * 100 - total) > 1:
            # Not repaired: with a plausible non-zero itemization AND a printed total that disagrees,
            # either one could be the right answer (a printed total including tax over pre-tax lines
            # is the common benign case) and picking one would be a guess presented as a fact. Logged
            # so the disagreement is at least visible if it turns out to be a pattern.
            logger.warning(
                "bill line items disagree with the printed total",
                line_items_cents=total,
                stated_total_cents=round(stated * 100),
                vendor=result.vendor_name[:80],
            )
        return result

    amounts_in_text = find_currency_amounts(f"{subject}\n{body_text}")

    if stated and stated > 0:
        logger.warning(
            "bill line items summed to zero, falling back to the printed total",
            stated_total=stated,
            vendor=result.vendor_name[:80],
            line_item_count=len(result.line_items),
        )
        return result.model_copy(
            update={"line_items": [LineItemDraft(description="Amount due", quantity=1, unit_price=stated)]}
        )

    raise BillExtractionFailed(
        "extraction produced a zero total"
        + (f"; amounts visible in the email text: {amounts_in_text[:5]}" if amounts_in_text else "")
    )


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
