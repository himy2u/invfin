import json
import os

from google import genai
from google.genai import errors as genai_errors
from pydantic import BaseModel
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from invoice_scan import _strip_markdown_fence
from logging_setup import logger

# Multi-turn version of the single-shot NL parse in invoice_nl.py — the model is stateless between
# calls, so the FULL prior draft and conversation are re-sent every turn and the model is
# explicitly told to carry forward any field the latest message didn't touch, rather than treating
# a silence on a field as "clear it."
CHAT_PROMPT = """You are helping a small-business owner build an invoice by chatting with them, one
message at a time. You maintain a running draft — never invent a client name, price, or detail
they haven't actually stated, and never blank out a field the user isn't currently talking about.

Current draft (JSON — null/empty fields are not yet known):
{draft_json}

Conversation so far:
{conversation}

The user just said: "{latest_message}"

Reply with JSON only, no other text, no markdown fences, matching exactly this shape:
{{
  "reply": string,
  "draft": {{
    "client_name": string or null,
    "client_email": string or null,
    "client_phone": string or null,
    "line_items": [{{"description": string, "quantity": number, "unit_price": number}}],
    "tax_rate_percent": number,
    "title": string or null,
    "summary": string or null,
    "po_number": string or null,
    "due_date": string or null (YYYY-MM-DD)
  }},
  "ready": boolean
}}
"reply" is a short, friendly response — ask ONE clarifying question at a time if something
important is still missing (client name, or at least one line item with a description and a
nonzero price), or briefly confirm what you just captured. "ready" is true only once there is a
client name AND at least one line item with a description and a price greater than 0 — it does NOT
require every optional field (title, PO number, due date) to be filled in.
Always carry forward every previous draft field the latest message didn't address — only change a
field the user is actually updating right now."""


class ChatLineItem(BaseModel):
    description: str
    quantity: float
    unit_price: float


class InvoiceDraft(BaseModel):
    client_name: str | None = None
    client_email: str | None = None
    client_phone: str | None = None
    line_items: list[ChatLineItem] = []
    tax_rate_percent: float = 0
    title: str | None = None
    summary: str | None = None
    po_number: str | None = None
    due_date: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatInvoiceResponse(BaseModel):
    reply: str
    draft: InvoiceDraft
    ready: bool


@retry(
    retry=retry_if_exception_type(genai_errors.ServerError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    reraise=True,
)
def _generate_with_retry(client: genai.Client, prompt: str):
    return client.models.generate_content(model="gemini-3.5-flash-lite", contents=prompt)


def chat_invoice_turn(messages: list[ChatMessage], draft: InvoiceDraft | None) -> ChatInvoiceResponse:
    if not messages or messages[-1].role != "user":
        raise ValueError("last message must be from the user")

    api_key = os.environ["GEMINI_API_KEY"]
    client = genai.Client(api_key=api_key)

    prior_conversation = messages[:-1]
    conversation_text = (
        "\n".join(f"{m.role}: {m.content}" for m in prior_conversation) if prior_conversation else "(none yet)"
    )
    draft_json = (draft or InvoiceDraft()).model_dump_json()

    prompt = CHAT_PROMPT.format(
        draft_json=draft_json,
        conversation=conversation_text,
        latest_message=messages[-1].content,
    )

    response = _generate_with_retry(client, prompt)
    raw = _strip_markdown_fence(response.text or "{}")
    data = json.loads(raw)

    logger.info("chat invoice turn", ready=data.get("ready"), has_client=bool(data.get("draft", {}).get("client_name")))

    return ChatInvoiceResponse(
        reply=data.get("reply", ""),
        draft=InvoiceDraft(**data.get("draft", {})),
        ready=bool(data.get("ready")),
    )
