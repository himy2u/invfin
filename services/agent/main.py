import asyncio
import os
import uuid

import structlog
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from invoice_chat import ChatInvoiceResponse, ChatMessage, InvoiceDraft, chat_invoice_turn
from invoice_export import InvoiceExportRequest, generate_invoice_csv, generate_invoice_pdf
from invoice_nl import parse_invoice_text
from invoice_scan import InvoiceScanResult, scan_invoice_csv, scan_invoice_image
from logging_setup import logger
from mailer import send_invoice_email

app = FastAPI(title="agent-service")

# Feature kill-switch: unset/false means the router (and every new dependency it pulls in —
# Supabase service-role client, Gemini classify/extract calls, push/reminder mailer) is never even
# mounted, so a problem in this feature can't affect any other endpoint's routing table or startup.
if os.environ.get("ENABLE_EMAIL_BILL_DETECTION", "").lower() in ("1", "true", "yes"):
    from email_bill_router import router as email_bill_router

    app.include_router(email_bill_router)
    logger.info("email bill detection feature enabled")

# The web app proxies through a Next.js API route (no browser CORS involved), but the mobile app
# calls this service directly from the client — and on the web-rendered mobile target
# (react-native-web / task dev:mobile:web), that's a real browser enforcing CORS. Any JSON POST
# (not multipart) triggers a preflight OPTIONS request without this.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(requestId=request_id)
    response = await call_next(request)
    response.headers["x-request-id"] = request_id
    return response


@app.get("/health")
def health() -> dict[str, str]:
    logger.info("agent received health check")
    return {"status": "ok"}


_CSV_TYPES = {"text/csv", "application/csv", "application/vnd.ms-excel"}
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10MB — a phone photo or a spreadsheet CSV both fit easily;
# anything larger has no legitimate reason to reach this endpoint and would otherwise cost
# unbounded memory/CPU (decode) and Gemini token spend with no guardrail.


@app.post("/scan-invoice", response_model=InvoiceScanResult)
async def scan_invoice(file: UploadFile = File(...)) -> InvoiceScanResult:
    is_image = bool(file.content_type and file.content_type.startswith("image/"))
    is_csv = file.content_type in _CSV_TYPES or (file.filename or "").lower().endswith(".csv")
    if not is_image and not is_csv:
        raise HTTPException(400, "expected an image or CSV file")

    contents = await file.read()
    if len(contents) > _MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file too large — 10MB max")
    logger.info("scanning invoice document", filename=file.filename, size=len(contents), is_csv=is_csv)

    try:
        # scan_invoice_csv/scan_invoice_image make a blocking (non-async) Gemini SDK call that can
        # legitimately take 10-45+ seconds. Calling it directly inside this async endpoint blocks
        # FastAPI's single event loop for that whole duration — every OTHER request (including an
        # unrelated, normally-instant /send-invoice-email) queues behind it and can time out. Real
        # symptom observed: a slow scan in one browser tab made a completely unrelated "send
        # invoice" action in another tab hang for 40+ seconds. Running it in a thread via
        # asyncio.to_thread frees the event loop to keep serving other requests concurrently.
        if is_csv:
            result = await asyncio.to_thread(scan_invoice_csv, contents.decode("utf-8", errors="replace"))
        else:
            result = await asyncio.to_thread(scan_invoice_image, contents, file.content_type)
    except Exception as exc:
        logger.error("invoice scan failed", error=str(exc))
        raise HTTPException(502, "scan failed — see agent logs") from exc

    logger.info("invoice scan complete", total_matches=result.total_matches_line_items)
    return result


class ParseTextRequest(BaseModel):
    text: str


@app.post("/parse-invoice-text", response_model=InvoiceScanResult)
async def parse_invoice_text_endpoint(body: ParseTextRequest) -> InvoiceScanResult:
    if not body.text.strip():
        raise HTTPException(400, "text is required")

    logger.info("parsing invoice text", length=len(body.text))
    try:
        # Same event-loop-blocking concern as /scan-invoice above — this is also a blocking Gemini
        # SDK call.
        result = await asyncio.to_thread(parse_invoice_text, body.text, os.environ["GEMINI_API_KEY"])
    except Exception as exc:
        logger.error("invoice text parse failed", error=str(exc))
        raise HTTPException(502, "parse failed — see agent logs") from exc

    logger.info("invoice text parse complete", client_name=result.client_name)
    return result


class ChatInvoiceRequest(BaseModel):
    messages: list[ChatMessage]
    draft: InvoiceDraft | None = None


@app.post("/chat-invoice", response_model=ChatInvoiceResponse)
async def chat_invoice_endpoint(body: ChatInvoiceRequest) -> ChatInvoiceResponse:
    if not body.messages or body.messages[-1].role != "user":
        raise HTTPException(400, "last message must be from the user")

    logger.info("chat invoice turn requested", turn=len(body.messages))
    try:
        # Blocking Gemini call — same to_thread treatment as the other endpoints above.
        result = await asyncio.to_thread(chat_invoice_turn, body.messages, body.draft)
    except Exception as exc:
        logger.error("chat invoice turn failed", error=str(exc))
        raise HTTPException(502, "chat failed — see agent logs") from exc

    return result


class SendInvoiceEmailRequest(BaseModel):
    to: str
    invoice_number: str
    total_formatted: str
    currency: str
    # Optional — when present, a PDF is generated and attached. Older callers that only pass the
    # basic fields still work (no attachment), so this stays backward-compatible.
    export: InvoiceExportRequest | None = None


# Only sends the email — does NOT touch invoice status. Each platform's own authenticated
# Supabase client (RLS-scoped) flips status to "sent" itself after this call succeeds, since this
# service has no user session context and shouldn't need service-role DB access just to send mail.
@app.post("/send-invoice-email")
async def send_invoice_email_endpoint(body: SendInvoiceEmailRequest) -> dict[str, bool]:
    logger.info("sending invoice email", to=body.to, invoice_number=body.invoice_number)
    try:
        pdf_bytes = generate_invoice_pdf(body.export) if body.export else None
        send_invoice_email(body.to, body.invoice_number, body.total_formatted, body.currency, pdf_bytes)
    except Exception as exc:
        logger.error("invoice email send failed", error=str(exc))
        raise HTTPException(502, "send failed — see agent logs") from exc

    logger.info("invoice email sent", to=body.to, with_pdf=body.export is not None)
    return {"ok": True}


@app.post("/generate-invoice-pdf")
async def generate_invoice_pdf_endpoint(body: InvoiceExportRequest) -> Response:
    try:
        pdf_bytes = generate_invoice_pdf(body)
    except Exception as exc:
        logger.error("pdf generation failed", error=str(exc))
        raise HTTPException(502, "PDF generation failed — see agent logs") from exc

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{body.invoice_number}.pdf"'},
    )


@app.post("/generate-invoice-csv")
async def generate_invoice_csv_endpoint(body: InvoiceExportRequest) -> Response:
    try:
        csv_text = generate_invoice_csv(body)
    except Exception as exc:
        logger.error("csv generation failed", error=str(exc))
        raise HTTPException(502, "CSV generation failed — see agent logs") from exc

    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{body.invoice_number}.csv"'},
    )
