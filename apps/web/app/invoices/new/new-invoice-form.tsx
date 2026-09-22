"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { posthog } from "@/instrumentation-client";
import { ChatInvoiceBuilder } from "./chat-invoice-builder";

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxLabel: string;
  discount: string;
};

type ScanResult = {
  document_type: "invoice" | "receipt" | "purchase_order" | "timesheet" | null;
  vendor: string | null;
  vendor_address?: string | null;
  client_name: string | null;
  client_address?: string | null;
  client_email?: string | null;
  client_phone?: string | null;
  invoice_number: string | null;
  reference_number: string | null;
  date: string | null;
  line_items: { description: string; quantity: number; unit_price: number }[];
  tax: number;
  total: number | null;
  total_matches_line_items: boolean;
  error?: string;
};

const emptyLineItem: LineItem = {
  description: "",
  quantity: "1",
  unitPrice: "0",
  taxRate: "0",
  taxLabel: "Tax",
  discount: "0",
};

function docTypeLabel(type: ScanResult["document_type"]): string {
  switch (type) {
    case "purchase_order":
      return "purchase order";
    case "timesheet":
      return "timesheet";
    case "receipt":
      return "receipt";
    default:
      return "photo";
  }
}

type ExistingClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  default_currency: string | null;
};

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

type Product = {
  id: string;
  name: string;
  description: string | null;
  default_price_cents: number;
  default_tax_rate_percent: number;
  default_tax_label: string;
};

type PastInvoice = { id: string; invoice_number: string; clients: { name: string } | null };

type BusinessProfile = { businessName: string; businessAddress: string; taxRegistrationNumber: string };

export function NewInvoiceForm({
  existingClients,
  pastInvoices,
  defaultCurrency,
  products,
  initialBusinessProfile,
}: {
  existingClients: ExistingClient[];
  pastInvoices: PastInvoice[];
  defaultCurrency: string;
  products: Product[];
  initialBusinessProfile: BusinessProfile;
}) {
  const router = useRouter();
  const supabase = createClient();
  // Read directly off window.location instead of next/navigation's useSearchParams, which would
  // force this whole form into a Suspense boundary just for one query-param check.
  const [autoOpenChat] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "chat",
  );

  // Always start empty, not pre-selecting an arbitrary "first" client — the autocomplete below
  // expects the user to search/select explicitly, since silently defaulting to one saved client
  // risks creating an invoice for the wrong customer without the user noticing.
  const [clientId, setClientId] = useState("");
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientAddress, setNewClientAddress] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState(`INV-${Date.now().toString().slice(-6)}`);
  const [dueDate, setDueDate] = useState("");
  const [terms, setTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  // "Bill From" was showing "Your business (not set)" on every new user's first invoice — nothing
  // ever prompted them to fill it in, even though a scanned document's own vendor/vendor_address
  // (extracted from a timesheet/PO/invoice) is exactly that business's name/address. Editable here
  // whenever the profile hasn't been set yet; saved alongside the invoice on submit so the next
  // invoice — and this one's own detail page, which reads profiles live — shows it correctly.
  const [businessName, setBusinessName] = useState(initialBusinessProfile.businessName);
  const [businessAddress, setBusinessAddress] = useState(initialBusinessProfile.businessAddress);
  const [taxRegistrationNumber, setTaxRegistrationNumber] = useState(
    initialBusinessProfile.taxRegistrationNumber,
  );
  const businessProfileWasEmpty = !initialBusinessProfile.businessName.trim();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [poNumber, setPoNumber] = useState("");
  // A single invoice-level tax (name + rate) applied to every line, matching how real invoices are
  // almost always taxed in practice (one HST/GST/VAT rate for the whole invoice) — per-line tax
  // name/rate columns in the table were pure clutter for the common case and buried the numbers
  // that actually matter (qty, rate, amount) among ones that never varied row to row.
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [lineItems, setLineItems] = useState<LineItem[]>([{ ...emptyLineItem }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [scanIsWarning, setScanIsWarning] = useState(false);
  // Offered after a non-timesheet scan/parse — a timesheet's rows are logged hours, not reusable
  // catalog items, but an invoice/receipt/PO's line items usually ARE products or services worth
  // remembering for next time, which is exactly what a product catalog is for.
  const [canSaveToCatalog, setCanSaveToCatalog] = useState(false);
  const [catalogSaved, setCatalogSaved] = useState(false);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>(products);
  const [nlText, setNlText] = useState("");
  const [parsingText, setParsingText] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [loadingTemplate, setLoadingTemplate] = useState(false);

  function updateLineItem(index: number, field: keyof LineItem, value: string) {
    setLineItems((items) =>
      items.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    );
  }

  function removeLineItem(index: number) {
    setLineItems((items) => (items.length > 1 ? items.filter((_, i) => i !== index) : items));
  }

  function addFromCatalog(productId: string) {
    const product = catalogProducts.find((p) => p.id === productId);
    if (!product) return;
    // Tax is invoice-level now — only adopt the product's default tax if nothing's been set yet,
    // rather than overwriting a rate the user already chose.
    if (taxRate === "0" && product.default_tax_rate_percent > 0) {
      setTaxRate(String(product.default_tax_rate_percent));
      setTaxLabel(product.default_tax_label);
    }
    const newLine: LineItem = {
      description: product.description ? `${product.name}: ${product.description}` : product.name,
      quantity: "1",
      unitPrice: (product.default_price_cents / 100).toString(),
      taxRate: "0",
      taxLabel: "Tax",
      discount: "0",
    };
    setLineItems((items) => {
      // The very first row starts out untouched (still the empty default) — fill it in place
      // instead of leaving a blank line above the picked product.
      const isFirstRowEmpty = items.length === 1 && !items[0].description && items[0].unitPrice === "0";
      return isFirstRowEmpty ? [newLine] : [...items, newLine];
    });
  }

  async function handleSaveToCatalog() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    // Skip anything that already matches an existing product by name (case-insensitive) so
    // scanning the same vendor's invoice twice doesn't pile up duplicate catalog entries.
    const existingNames = new Set(catalogProducts.map((p) => p.name.trim().toLowerCase()));
    const toInsert = lineItems.filter(
      (item) => item.description.trim() && !existingNames.has(item.description.trim().toLowerCase()),
    );
    if (toInsert.length === 0) {
      setCatalogSaved(true);
      return;
    }

    const { data, error: insertError } = await supabase
      .from("products")
      .insert(
        toInsert.map((item) => ({
          user_id: session.user.id,
          name: item.description.trim(),
          default_price_cents: Math.round(Number(item.unitPrice) * 100) || 0,
          default_tax_label: taxLabel || "Tax",
          default_tax_rate_percent: Number(taxRate) || 0,
        })),
      )
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label");
    if (insertError) return;

    setCatalogProducts((prev) => [...prev, ...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
    setCatalogSaved(true);
  }

  function lineAmount(item: LineItem) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    return (qty * price).toFixed(2);
  }

  const lineItemsSubtotal = lineItems.reduce((sum, item) => sum + Number(lineAmount(item)), 0);
  const lineItemsTax = lineItemsSubtotal * ((Number(taxRate) || 0) / 100);

  // Shared by scan and natural-language parsing — both ultimately fill the same fields, and per
  // UX research on this pattern, a user's edit after either method is final: neither method
  // re-runs or re-validates against the model once the user starts editing.
  function applyExtractedData(data: ScanResult, sourceLabel: string) {
    setClientId("");
    setNewClientName(data.client_name ?? "");
    if (data.client_address) setNewClientAddress(data.client_address);
    if (data.client_email) setNewClientEmail(data.client_email);
    if (data.client_phone) setNewClientPhone(data.client_phone);
    if (data.invoice_number) setInvoiceNumber(data.invoice_number);
    // A scanned timesheet/PO/invoice already prints the user's OWN business name/address as
    // "vendor" — only offer it while the profile is genuinely still empty, never overwrite a
    // business profile the user already set up.
    if (businessProfileWasEmpty) {
      if (data.vendor) setBusinessName(data.vendor);
      if (data.vendor_address) setBusinessAddress(data.vendor_address);
    }
    if (data.line_items.length > 0) {
      const lineItemsSum = data.line_items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      // The extraction returns tax as one flat dollar amount — convert to an equivalent invoice-
      // level rate so the created invoice's total still matches what was actually printed on the
      // scanned document.
      const impliedTaxRate = data.tax > 0 && lineItemsSum > 0 ? (data.tax / lineItemsSum) * 100 : 0;
      setTaxRate(String(Math.round(impliedTaxRate * 100) / 100));
      setLineItems(
        data.line_items.map((item) => ({
          description: item.description,
          quantity: String(item.quantity),
          unitPrice: String(item.unit_price),
          taxRate: "0",
          taxLabel: "Tax",
          discount: "0",
        })),
      );
    }

    // Scanning a customer's PO: cite their PO number in the dedicated field so it shows on the
    // invoice the way Wave/Xero/QuickBooks do, not buried in the free-text terms.
    if (data.document_type === "purchase_order" && data.reference_number) {
      setPoNumber(data.reference_number);
    }

    // A real total mismatch and a routine "go check this field" nudge were rendered identically
    // (same color, same box) — indistinguishable at a skim, which is exactly the kind of silent
    // wrongness this product's pitch says it will never do.
    setScanIsWarning(data.document_type !== "timesheet" && !data.total_matches_line_items);
    setCanSaveToCatalog(data.document_type !== "timesheet" && data.line_items.length > 0);
    setCatalogSaved(false);
    setScanNotice(
      data.document_type === "timesheet"
        ? `Read hours from the timesheet. Fill in the rate per line and the client's email/phone before creating.`
        : data.total_matches_line_items
          ? `Read from ${data.vendor ?? "the"} ${sourceLabel}. Check the client's email/phone below before creating.`
          : `Read from ${data.vendor ?? "the"} ${sourceLabel}, but the total didn't match the line items. Double-check the amounts before creating.`,
    );
  }

  function applyChatDraft(draft: {
    client_name: string | null;
    client_email: string | null;
    client_phone: string | null;
    line_items: { description: string; quantity: number; unit_price: number }[];
    tax_rate_percent: number;
    title: string | null;
    summary: string | null;
    po_number: string | null;
    due_date: string | null;
  }) {
    setClientId("");
    setNewClientName(draft.client_name ?? "");
    if (draft.client_email) setNewClientEmail(draft.client_email);
    if (draft.client_phone) setNewClientPhone(draft.client_phone);
    if (draft.title) setTitle(draft.title);
    if (draft.summary) setSummary(draft.summary);
    if (draft.po_number) setPoNumber(draft.po_number);
    if (draft.due_date) setDueDate(draft.due_date);
    setTaxRate(String(draft.tax_rate_percent || 0));
    if (draft.line_items.length > 0) {
      setLineItems(
        draft.line_items.map((item) => ({
          description: item.description,
          quantity: String(item.quantity),
          unitPrice: String(item.unit_price),
          taxRate: "0",
          taxLabel: "Tax",
          discount: "0",
        })),
      );
    }
  }

  async function handleUseTemplate(id: string) {
    setTemplateId(id);
    if (!id) return;

    setLoadingTemplate(true);
    setError(null);
    try {
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .select("client_id, terms, currency, title, summary, po_number")
        .eq("id", id)
        .single();
      if (invoiceError || !invoice) throw new Error("couldn't load that invoice");

      const { data: items, error: itemsError } = await supabase
        .from("invoice_line_items")
        .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label, discount_cents")
        .eq("invoice_id", id)
        .order("sort_order");
      if (itemsError) throw itemsError;

      // Copies the client and line items as a starting point — deliberately does NOT copy the
      // invoice number, issue date, or due date, since those are exactly what should change for
      // a new invoice. Quantities/prices carry over but stay fully editable before submitting.
      setClientId(invoice.client_id);
      setTerms(invoice.terms ?? "");
      setCurrency(invoice.currency);
      setTitle(invoice.title ?? "");
      setSummary(invoice.summary ?? "");
      // A PO number is specific to the deal that produced the original invoice — copying it forward
      // as-is would misattribute the new invoice to the old purchase order, so this deliberately
      // stays blank.
      if (items && items.length > 0) {
        // Tax is invoice-level now — carry forward the first line's rate/name as the shared value
        // (the common case is every line already sharing one rate anyway).
        setTaxRate(String(items[0].tax_rate_percent));
        setTaxLabel(items[0].tax_label);
        setLineItems(
          items.map((item) => ({
            description: item.description,
            quantity: String(item.quantity),
            unitPrice: (item.unit_price_cents / 100).toString(),
            taxRate: "0",
            taxLabel: "Tax",
            discount: (item.discount_cents / 100).toString(),
          })),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't load that invoice as a template");
    } finally {
      setLoadingTemplate(false);
    }
  }

  async function handleScan(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setScanning(true);
    setScanNotice(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/scan-invoice", { method: "POST", body: formData });
      const data: ScanResult = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");

      // Pre-fill only — never auto-submits. Scans can't reliably read a client's email/phone
      // (rarely printed on the invoice itself), so that field is always left for manual entry.
      const sourceLabel = docTypeLabel(data.document_type);
      applyExtractedData(data, sourceLabel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function handleParseText() {
    if (!nlText.trim()) return;

    setParsingText(true);
    setScanNotice(null);
    setError(null);

    try {
      const res = await fetch("/api/parse-invoice-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: nlText }),
      });
      const data: ScanResult = await res.json();
      if (!res.ok) throw new Error(data.error ?? "parse failed");

      applyExtractedData(data, "request");
    } catch (err) {
      setError(err instanceof Error ? err.message : "parse failed");
    } finally {
      setParsingText(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      let finalClientId = clientId;

      // getSession() reads the already-verified session from local storage — no network round
      // trip. getUser() re-validates against the auth server on every call, so a flaky connection
      // can make it fail transiently and throw "not signed in" even though the user is genuinely
      // signed in (this page is only reachable because middleware already confirmed a session
      // exists).
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("not signed in");
      const user = session.user;

      if (!finalClientId && newClientName.trim()) {
        if (!newClientEmail.trim() && !newClientPhone.trim()) {
          throw new Error(
            "client needs an email or phone, that's what delivery/open notifications go to",
          );
        }

        // Typing a name that matches an existing client (instead of picking it from the
        // autocomplete dropdown — e.g. after a scan/chat prefill) must reuse that client, not
        // silently create a duplicate. existingClients is already loaded for the autocomplete, so
        // this is a local match, not another round trip.
        const trimmedName = newClientName.trim().toLowerCase();
        const trimmedEmail = newClientEmail.trim().toLowerCase();
        const duplicate = existingClients.find(
          (c) => c.name.trim().toLowerCase() === trimmedName || (trimmedEmail && c.email?.toLowerCase() === trimmedEmail),
        );

        if (duplicate) {
          finalClientId = duplicate.id;
        } else {
          const { data: client, error: clientError } = await supabase
            .from("clients")
            .insert({
              user_id: user.id,
              name: newClientName.trim(),
              email: newClientEmail.trim() || null,
              phone: newClientPhone.trim() || null,
              billing_address: newClientAddress.trim() || null,
            })
            .select("id")
            .single();
          if (clientError) throw clientError;
          finalClientId = client.id;
        }
      }

      if (!finalClientId) throw new Error("select or create a client");

      // The "From" block was showing "not set" for every new user's first invoice — save whatever
      // business info was entered/prefilled from a scan right alongside creating the invoice,
      // instead of requiring a separate trip to Settings first.
      if (businessProfileWasEmpty && businessName.trim()) {
        await supabase.from("profiles").upsert({
          user_id: user.id,
          business_name: businessName.trim(),
          business_address: businessAddress.trim() || null,
          tax_registration_number: taxRegistrationNumber.trim() || null,
        });
      }

      const { data: invoiceId, error: rpcError } = await supabase.rpc(
        "create_invoice_with_line_items",
        {
          p_client_id: finalClientId,
          p_invoice_number: invoiceNumber,
          p_currency: currency,
          p_issue_date: new Date().toISOString().slice(0, 10),
          p_due_date: dueDate || undefined,
          p_terms: terms || undefined,
          p_notes: notes || undefined,
          p_title: title || undefined,
          p_summary: summary || undefined,
          p_po_number: poNumber || undefined,
          p_line_items: lineItems.map((item) => ({
            description: item.description,
            quantity: Number(item.quantity),
            unit_price_cents: Math.round(Number(item.unitPrice) * 100),
            // One shared tax rate/name applies to every line — see the taxRate/taxLabel state
            // above for why this is invoice-level rather than per-line in the UI.
            tax_rate_percent: Number(taxRate) || 0,
            tax_label: taxLabel || "Tax",
            discount_cents: Math.round(Number(item.discount) * 100),
          })),
        },
      );

      if (rpcError) throw rpcError;

      console.log(`[trace] invoice created: ${invoiceId}`);
      // Naming aligned with Stripe's invoice.* webhook event taxonomy (invoice.created,
      // invoice.finalized, invoice.paid) since Phase 4 wires real Stripe events into the same
      // PostHog project — matching now avoids a rename later.
      posthog.capture("invoice.created", {
        invoice_id: invoiceId,
        line_item_count: lineItems.length,
        creation_mode: templateId ? "template" : scanNotice ? "scan" : "manual",
      });
      router.push("/invoices");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create invoice");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedClient = existingClients.find((c) => c.id === clientId);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {pastInvoices.length > 0 && (
        <div>
          <label className="mb-1 block text-sm">Use a past invoice as a template (optional)</label>
          <select
            value={templateId}
            onChange={(e) => handleUseTemplate(e.target.value)}
            disabled={loadingTemplate}
            data-testid="template-select"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">Start from scratch</option>
            {pastInvoices.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.invoice_number}: {inv.clients?.name ?? "Unknown client"}
              </option>
            ))}
          </select>
          {loadingTemplate && <p className="mt-1 text-sm text-zinc-500">Loading…</p>}
          {templateId && !loadingTemplate && (
            <p className="mt-1 text-xs text-zinc-500" data-testid="template-notice">
              Copied the client and line items. Adjust quantities, prices, or dates below before creating.
            </p>
          )}
        </div>
      )}

      <div className="mb-2">
        <ChatInvoiceBuilder onUseDraft={applyChatDraft} autoOpen={autoOpenChat} />
      </div>

      <div className="rounded-lg border border-dashed border-teal-300 bg-teal-50 p-4">
        <label className="mb-1 block text-sm font-medium text-teal-900">
          Describe it, or scan a photo, either pre-fills the form below (optional)
        </label>
        <div className="flex gap-2">
          <input
            placeholder='"bill Acme Corp $500 for design work"'
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            disabled={parsingText}
            data-testid="nl-text-input"
            className="flex-1 rounded border border-teal-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={handleParseText}
            disabled={parsingText || !nlText.trim()}
            data-testid="nl-parse-button"
            className="rounded bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {parsingText ? "…" : "Parse"}
          </button>
        </div>
        <div className="mt-2">
          <input
            type="file"
            accept="image/*,.csv,text/csv"
            onChange={handleScan}
            disabled={scanning}
            data-testid="scan-file-input"
            className="text-sm"
          />
        </div>
        {(scanning || parsingText) && (
          <p className="mt-2 text-sm text-teal-700">
            {scanning ? "Reading photo…" : "Parsing…"}
          </p>
        )}
        {scanNotice && (
          <p
            className={`mt-2 text-sm ${scanIsWarning ? "font-medium text-amber-700" : "text-teal-800"}`}
            data-testid="scan-notice"
          >
            {scanIsWarning ? "⚠ " : ""}
            {scanNotice}
          </p>
        )}
        {canSaveToCatalog && !catalogSaved && (
          <button
            type="button"
            onClick={handleSaveToCatalog}
            data-testid="save-to-catalog-button"
            className="mt-2 text-sm text-teal-700 underline"
          >
            + Save these items to your product catalog
          </button>
        )}
        {catalogSaved && (
          <p className="mt-2 text-sm text-teal-700" data-testid="catalog-saved-notice">
            ✓ Saved to your catalog. Pick them from &quot;Add from catalog&quot; next time.
          </p>
        )}
      </div>

      {businessProfileWasEmpty ? (
        <div className="rounded-lg border border-zinc-200 p-4">
          <label className="mb-2 block text-sm font-medium">
            Your business info <span className="font-normal text-zinc-500">(shown as &quot;From&quot; on the invoice)</span>
          </label>
          <div className="flex flex-col gap-2">
            <input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Business name"
              data-testid="business-name-input"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
            <textarea
              value={businessAddress}
              onChange={(e) => setBusinessAddress(e.target.value)}
              placeholder="Business address"
              rows={2}
              data-testid="business-address-input"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
            <input
              value={taxRegistrationNumber}
              onChange={(e) => setTaxRegistrationNumber(e.target.value)}
              placeholder="Tax registration number (optional)"
              data-testid="tax-registration-input"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>
          <p className="mt-1 text-xs text-zinc-500">Saved to your business profile once you create this invoice.</p>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-2 text-sm">
          <span className="text-zinc-600">
            From: <span className="font-medium text-zinc-800">{businessName}</span>
          </span>
          <a href="/settings" className="text-teal-700 underline">
            Edit
          </a>
        </div>
      )}

      <div className="relative">
        <label className="mb-1 block text-sm">Client</label>
        {clientId ? (
          <div className="rounded border border-teal-300 bg-teal-50 px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span data-testid="selected-client">{selectedClient?.name} (saved client)</span>
              <button
                type="button"
                onClick={() => setClientId("")}
                className="text-teal-700 underline"
                data-testid="change-client-button"
              >
                Change
              </button>
            </div>
            {selectedClient?.billing_address && (
              <p className="mt-1 text-xs text-teal-800">{selectedClient.billing_address}</p>
            )}
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <input
              placeholder="Search or type a new client name"
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
              data-testid="new-client-name"
              autoComplete="off"
            />
            {newClientName.trim().length > 0 &&
              (() => {
                const matches = existingClients.filter((c) =>
                  c.name.toLowerCase().includes(newClientName.trim().toLowerCase()),
                );
                if (matches.length === 0) return null;
                return (
                  <ul
                    className="rounded border border-zinc-200 bg-white shadow-sm"
                    data-testid="client-suggestions"
                  >
                    {matches.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setClientId(c.id);
                            setNewClientName("");
                            setNewClientEmail("");
                            setNewClientPhone("");
                            setNewClientAddress("");
                            if (c.default_currency) setCurrency(c.default_currency);
                          }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-teal-50"
                          data-testid="client-suggestion"
                        >
                          {c.name}
                          {c.email ? ` · ${c.email}` : c.phone ? ` · ${c.phone}` : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            <input
              type="email"
              placeholder="Client email (or phone below)"
              value={newClientEmail}
              onChange={(e) => setNewClientEmail(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
              data-testid="new-client-email"
            />
            <input
              type="tel"
              placeholder="Client phone (or email above)"
              value={newClientPhone}
              onChange={(e) => setNewClientPhone(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
            <textarea
              placeholder="Billing address (optional)"
              value={newClientAddress}
              onChange={(e) => setNewClientAddress(e.target.value)}
              rows={2}
              className="w-full rounded border border-zinc-300 px-3 py-2"
              data-testid="new-client-address"
            />
            <p className="text-xs text-zinc-500">
              Email or phone is required. It's how they get delivery/open notifications.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm">Invoice number</label>
          <input
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Currency</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            data-testid="currency-select"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm">Due date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">P.O./S.O. number (optional)</label>
          <input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            placeholder="PO-1024"
            data-testid="po-number-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm">Invoice title (optional)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Invoice"
          data-testid="invoice-title-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm">Summary (optional)</label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="A short note that appears near the top of the invoice"
          data-testid="invoice-summary-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium">
            Line items{" "}
            <span
              className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600"
              data-testid="line-item-count"
            >
              {lineItems.length}
            </span>
          </label>
          <div className="flex items-center gap-3">
            {catalogProducts.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addFromCatalog(e.target.value);
                  e.target.value = "";
                }}
                data-testid="add-from-catalog-select"
                className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-600"
              >
                <option value="">+ Add from catalog…</option>
                {catalogProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setLineItems((items) => [...items, { ...emptyLineItem }])}
              className="text-sm text-teal-700 underline"
            >
              + Add line
            </button>
          </div>
        </div>

        {/* A bordered table (not a bare grid) so the eye can track a row across many columns —
            Wave, Xero, QuickBooks all use ruled tables here, not floating input grids. Amount is
            computed (qty × rate), never a raw input. Tax is set once for the whole invoice (below
            the table) rather than per line — the common case is one HST/GST/VAT rate for
            everything, and a rate/name column repeated on every row was clutter, not information. */}
        <div className="overflow-x-auto rounded border border-zinc-300">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-300 bg-zinc-50 text-xs font-medium text-zinc-500">
                <th className="w-10 px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Description</th>
                <th className="w-20 px-2 py-2 text-left">Qty</th>
                <th className="w-24 px-2 py-2 text-left">Rate</th>
                <th className="w-28 px-2 py-2 text-right">Amount</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => (
                <tr
                  key={i}
                  className="border-b border-zinc-100 last:border-b-0 even:bg-zinc-50/50"
                  data-testid="line-item-row"
                >
                  <td className="px-2 py-1.5 text-zinc-400">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <input
                      placeholder="Description"
                      value={item.description}
                      onChange={(e) => updateLineItem(i, "description", e.target.value)}
                      required
                      className="w-full rounded border border-zinc-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      placeholder="Qty"
                      value={item.quantity}
                      onChange={(e) => updateLineItem(i, "quantity", e.target.value)}
                      className="w-full rounded border border-zinc-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      placeholder="Rate"
                      value={item.unitPrice}
                      onChange={(e) => updateLineItem(i, "unitPrice", e.target.value)}
                      className="w-full rounded border border-zinc-300 px-2 py-1"
                    />
                  </td>
                  <td
                    className="px-2 py-1.5 text-right font-medium text-zinc-700"
                    data-testid="line-item-amount"
                  >
                    {lineAmount(item)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => removeLineItem(i)}
                      disabled={lineItems.length === 1}
                      aria-label={`Remove line ${i + 1}`}
                      className="text-zinc-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-300 bg-zinc-50 text-sm">
                <td colSpan={3} className="px-2 py-2 text-right font-medium text-zinc-600">
                  Subtotal
                </td>
                <td className="px-2 py-2 text-right font-medium text-zinc-700">
                  {lineItemsSubtotal.toFixed(2)}
                </td>
                <td />
              </tr>
              <tr className="text-sm">
                <td colSpan={3} className="px-2 py-2 text-right align-middle">
                  <div className="flex items-center justify-end gap-2">
                    <input
                      value={taxLabel}
                      onChange={(e) => setTaxLabel(e.target.value)}
                      placeholder="HST, GST, VAT…"
                      data-testid="invoice-tax-label"
                      className="w-28 rounded border border-zinc-300 px-2 py-1 text-right text-xs"
                    />
                    <input
                      type="number"
                      value={taxRate}
                      onChange={(e) => setTaxRate(e.target.value)}
                      placeholder="0"
                      data-testid="invoice-tax-rate"
                      className="w-16 rounded border border-zinc-300 px-2 py-1 text-right text-xs"
                    />
                    <span className="text-zinc-500">%</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right font-medium text-zinc-700">
                  {lineItemsTax.toFixed(2)}
                </td>
                <td />
              </tr>
              <tr className="border-t border-zinc-300 text-sm">
                <td colSpan={3} className="px-2 py-2 text-right font-semibold text-zinc-800">
                  Total
                </td>
                <td className="px-2 py-2 text-right font-semibold text-zinc-900">
                  {(lineItemsSubtotal + lineItemsTax).toFixed(2)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm">Terms / notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-teal-700 px-4 py-2 text-white hover:bg-teal-800 disabled:opacity-50"
        data-testid="submit-invoice-button"
      >
        {submitting ? "Creating…" : "Create invoice"}
      </button>
    </form>
  );
}
