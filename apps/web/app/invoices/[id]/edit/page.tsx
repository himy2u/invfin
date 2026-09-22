import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EditInvoiceForm } from "./edit-invoice-form";

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, status, currency, due_date, terms, notes, title, summary, po_number, clients(name)",
    )
    .eq("id", id)
    .single();

  if (!invoice) notFound();
  // Editing a paid/void invoice would silently rewrite what was actually billed — same principle
  // as never guessing payment status, applied to the invoice content itself.
  if (["paid", "partially_paid", "void"].includes(invoice.status)) {
    redirect(`/invoices/${id}`);
  }

  const { data: lineItems } = await supabase
    .from("invoice_line_items")
    .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label, discount_cents")
    .eq("invoice_id", id)
    .order("sort_order");

  // Tax became invoice-level in this session's redesign — a legacy invoice whose lines carried
  // different rates can no longer be represented exactly by one shared control. Rather than
  // silently collapsing them to the first line's rate on save, surface it so the user can decide.
  const distinctRates = new Set((lineItems ?? []).map((i) => i.tax_rate_percent));
  const hasMixedTaxRates = distinctRates.size > 1;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-1 text-xl font-semibold">Edit {invoice.invoice_number}</h1>
      <p className="mb-6 text-sm text-zinc-500">Billing {invoice.clients?.name}</p>
      {hasMixedTaxRates && (
        <p className="mb-6 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This invoice&apos;s lines have different tax rates. Saving will apply one shared rate to
          every line. Check the rate below before saving.
        </p>
      )}
      <EditInvoiceForm
        invoiceId={invoice.id}
        currency={invoice.currency}
        initial={{
          dueDate: invoice.due_date ?? "",
          terms: invoice.terms ?? "",
          notes: invoice.notes ?? "",
          title: invoice.title ?? "",
          summary: invoice.summary ?? "",
          poNumber: invoice.po_number ?? "",
          lineItems: (lineItems ?? []).map((item) => ({
            description: item.description,
            quantity: String(item.quantity),
            unitPrice: (item.unit_price_cents / 100).toString(),
            taxRate: String(item.tax_rate_percent),
            taxLabel: item.tax_label,
            discount: (item.discount_cents / 100).toString(),
          })),
        }}
      />
    </main>
  );
}
