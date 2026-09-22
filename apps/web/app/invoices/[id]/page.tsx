import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SendInvoiceButton } from "./send-invoice-button";
import { ExportButtons } from "./export-buttons";

const UNEDITABLE_STATUSES = ["paid", "partially_paid", "void"];

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, status, currency, subtotal_cents, tax_cents, discount_cents, total_cents, amount_paid_cents, issue_date, due_date, terms, notes, sent_at, user_id, title, summary, po_number, clients(name, email, phone, billing_address)",
    )
    .eq("id", id)
    .single();

  if (!invoice) notFound();

  const [{ data: lineItems }, { data: profile }, { data: versions }] = await Promise.all([
    supabase
      .from("invoice_line_items")
      .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label, sort_order")
      .eq("invoice_id", id)
      .order("sort_order"),
    supabase
      .from("profiles")
      .select("business_name, business_address, tax_registration_number")
      .eq("user_id", invoice.user_id)
      .maybeSingle(),
    supabase
      .from("invoice_versions")
      .select("version_number, snapshot, created_at")
      .eq("invoice_id", id)
      .order("version_number", { ascending: false }),
  ]);

  const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${invoice.currency}`;

  // If every line uses the same tax label, show that name in the totals row (matching how a real
  // invoice reads, e.g. "HST 13%") instead of a generic "Tax" — falls back to generic when mixed.
  const distinctTaxLabels = new Set((lineItems ?? []).map((i) => i.tax_label));
  const taxSummaryLabel = distinctTaxLabels.size === 1 ? [...distinctTaxLabels][0] : "Tax";

  return (
    <main className="mx-auto max-w-2xl px-6 py-16" data-testid="invoice-detail">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{invoice.title || "Invoice"}</h1>
          <p className="text-sm text-zinc-500">
            {invoice.invoice_number}
            {invoice.po_number && (
              <span data-testid="invoice-po-number"> · PO {invoice.po_number}</span>
            )}
            {" · "}
            {invoice.currency}
          </p>
          {invoice.summary && (
            <p className="mt-2 text-sm text-zinc-600" data-testid="invoice-summary">
              {invoice.summary}
            </p>
          )}

          <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
            <div data-testid="bill-from">
              <p className="text-xs font-medium text-zinc-400">From</p>
              <p className="text-zinc-700">{profile?.business_name ?? "Your business (not set)"}</p>
              {profile?.business_address && (
                <p className="whitespace-pre-line text-zinc-500">{profile.business_address}</p>
              )}
              {profile?.tax_registration_number && (
                <p className="text-zinc-500">Tax ID: {profile.tax_registration_number}</p>
              )}
            </div>
            <div data-testid="bill-to">
              <p className="text-xs font-medium text-zinc-400">Bill to</p>
              <p className="text-zinc-700">{invoice.clients?.name}</p>
              <p className="text-zinc-500">{invoice.clients?.email ?? invoice.clients?.phone}</p>
              {invoice.clients?.billing_address && (
                <p className="whitespace-pre-line text-zinc-500" data-testid="client-address">
                  {invoice.clients.billing_address}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className="whitespace-nowrap rounded-full bg-teal-100 px-3 py-1 text-sm font-medium text-teal-800"
            data-testid="invoice-status"
          >
            {invoice.status}
            {invoice.sent_at ? ` · sent ${new Date(invoice.sent_at).toLocaleDateString()}` : ""}
          </span>
          {!UNEDITABLE_STATUSES.includes(invoice.status) && (
            <Link
              href={`/invoices/${invoice.id}/edit`}
              className="text-sm text-teal-700 underline"
              data-testid="edit-invoice-link"
            >
              Edit
            </Link>
          )}
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-zinc-500">
            <tr>
              <th className="p-3">Description</th>
              <th className="p-3">Qty</th>
              <th className="p-3">Rate</th>
              <th className="p-3">Tax</th>
              <th className="p-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lineItems?.map((item, i) => (
              <tr key={i} className="border-b border-zinc-100 last:border-0" data-testid="detail-line-item">
                <td className="p-3">{item.description}</td>
                <td className="p-3">{item.quantity}</td>
                <td className="p-3">{(item.unit_price_cents / 100).toFixed(2)}</td>
                <td className="p-3">
                  {item.tax_rate_percent > 0 ? `${item.tax_label} ${item.tax_rate_percent}%` : "-"}
                </td>
                <td className="p-3 text-right">
                  {((item.quantity * item.unit_price_cents) / 100).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col gap-1 border-t border-zinc-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Subtotal</span>
            <span>{fmt(invoice.subtotal_cents)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">{taxSummaryLabel}</span>
            <span>{fmt(invoice.tax_cents)}</span>
          </div>
          <div className="flex justify-between font-semibold" data-testid="detail-total">
            <span>Total</span>
            <span>{fmt(invoice.total_cents)}</span>
          </div>
          {invoice.amount_paid_cents > 0 && (
            <div className="flex justify-between text-teal-700">
              <span>Paid</span>
              <span>{fmt(invoice.amount_paid_cents)}</span>
            </div>
          )}
        </div>
      </div>

      {invoice.terms && (
        <p className="mb-6 text-sm text-zinc-600">
          <span className="font-medium">Terms: </span>
          {invoice.terms}
        </p>
      )}

      <ExportButtons invoiceId={invoice.id} />

      <SendInvoiceButton
        invoiceId={invoice.id}
        alreadySent={invoice.status !== "draft"}
        hasClientEmail={Boolean(invoice.clients?.email)}
      />

      {versions && versions.length > 0 && (
        <div className="mt-10 border-t border-zinc-200 pt-6">
          <h2 className="mb-3 text-sm font-semibold text-zinc-700">Edit history</h2>
          <ul className="flex flex-col gap-2" data-testid="edit-history-list">
            {versions.map((v) => {
              const snapshot = v.snapshot as {
                invoice: { total_cents: number };
                line_items: unknown[];
              };
              return (
                <li
                  key={v.version_number}
                  className="rounded border border-zinc-200 p-3 text-sm text-zinc-600"
                  data-testid="edit-history-entry"
                >
                  <span className="font-medium text-zinc-800">Version {v.version_number}</span>
                  {" · "}
                  {new Date(v.created_at).toLocaleString()}
                  {" · was "}
                  {(snapshot.invoice.total_cents / 100).toFixed(2)} {invoice.currency}
                  {", "}
                  {snapshot.line_items.length} line item{snapshot.line_items.length === 1 ? "" : "s"}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </main>
  );
}
