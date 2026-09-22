"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxLabel: string;
  discount: string;
};

type Initial = {
  dueDate: string;
  terms: string;
  notes: string;
  title: string;
  summary: string;
  poNumber: string;
  lineItems: LineItem[];
};

export function EditInvoiceForm({
  invoiceId,
  currency,
  initial,
}: {
  invoiceId: string;
  currency: string;
  initial: Initial;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [dueDate, setDueDate] = useState(initial.dueDate);
  const [terms, setTerms] = useState(initial.terms);
  const [notes, setNotes] = useState(initial.notes);
  const [title, setTitle] = useState(initial.title);
  const [summary, setSummary] = useState(initial.summary);
  const [poNumber, setPoNumber] = useState(initial.poNumber);
  // Tax is invoice-level — seed the shared control from the first line's existing rate/name
  // (the common case is every line already sharing one rate).
  const [taxLabel, setTaxLabel] = useState(initial.lineItems[0]?.taxLabel || "Tax");
  const [taxRate, setTaxRate] = useState(initial.lineItems[0]?.taxRate || "0");
  const [lineItems, setLineItems] = useState<LineItem[]>(initial.lineItems);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateLineItem(index: number, field: keyof LineItem, value: string) {
    setLineItems((items) => items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function removeLineItem(index: number) {
    setLineItems((items) => (items.length > 1 ? items.filter((_, i) => i !== index) : items));
  }

  function lineAmount(item: LineItem) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    return (qty * price).toFixed(2);
  }

  const subtotal = lineItems.reduce((sum, item) => sum + Number(lineAmount(item)), 0);
  const tax = subtotal * ((Number(taxRate) || 0) / 100);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const { error: rpcError } = await supabase.rpc("update_invoice_with_line_items", {
        p_invoice_id: invoiceId,
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
          tax_rate_percent: Number(taxRate) || 0,
          tax_label: taxLabel || "Tax",
          // Preserve any existing per-line discount (set only via the template-copy path today,
          // with no dedicated UI here) — hardcoding this to 0 was silently dropping a real
          // discount on every save, increasing the total the client is billed.
          discount_cents: Math.round(Number(item.discount || "0") * 100),
        })),
      });
      if (rpcError) throw rpcError;

      router.push(`/invoices/${invoiceId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save changes");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
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
          data-testid="invoice-title-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm">Summary (optional)</label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          data-testid="invoice-summary-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium">
            Line items{" "}
            <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600">
              {lineItems.length}
            </span>
          </label>
          <button
            type="button"
            onClick={() =>
              setLineItems((items) => [
                ...items,
                { description: "", quantity: "1", unitPrice: "0", taxRate: "0", taxLabel: "Tax", discount: "0" },
              ])
            }
            className="text-sm text-teal-700 underline"
          >
            + Add line
          </button>
        </div>

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
                <tr key={i} className="border-b border-zinc-100 last:border-b-0 even:bg-zinc-50/50" data-testid="line-item-row">
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
                  <td className="px-2 py-1.5 text-right font-medium text-zinc-700">{lineAmount(item)}</td>
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
                  {subtotal.toFixed(2)} {currency}
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
                  {tax.toFixed(2)} {currency}
                </td>
                <td />
              </tr>
              <tr className="border-t border-zinc-300 text-sm">
                <td colSpan={3} className="px-2 py-2 text-right font-semibold text-zinc-800">
                  Total
                </td>
                <td className="px-2 py-2 text-right font-semibold text-zinc-900">
                  {(subtotal + tax).toFixed(2)} {currency}
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
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-teal-700 px-4 py-2 text-white hover:bg-teal-800 disabled:opacity-50"
          data-testid="save-invoice-edit-button"
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/invoices/${invoiceId}`)}
          className="rounded border border-zinc-300 px-4 py-2 text-zinc-700 hover:bg-zinc-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
