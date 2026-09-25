import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatAmount, formatMoney } from "@/lib/money";
import { MarkPaidButton } from "./mark-paid-button";
import { ReminderEditor } from "./reminder-editor";

export default async function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: bill } = await supabase
    .from("bills")
    .select(
      "id, bill_number, status, currency, subtotal_cents, tax_cents, total_cents, vendor_name, vendor_address, vendor_email, vendor_phone, issue_date, due_date, po_number, terms, paid_at, reminder_mode, reminder_offset_value, reminder_offset_unit, reminder_at, reminder_sent_at, duplicate_of_bill_id",
    )
    .eq("id", id)
    .single();

  if (!bill) notFound();

  const { data: lineItems } = await supabase
    .from("bill_line_items")
    .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label")
    .eq("bill_id", id)
    .order("sort_order");

  const fmt = (cents: number) => formatMoney(cents, bill.currency);

  // Named, not just linked by id: "possible duplicate of 8f3c-…" is useless to a human, and the
  // number is the thing they'd actually compare against the vendor's own paperwork.
  const { data: duplicateOf } = bill.duplicate_of_bill_id
    ? await supabase.from("bills").select("id, bill_number").eq("id", bill.duplicate_of_bill_id).maybeSingle()
    : { data: null };
  const distinctTaxLabels = new Set((lineItems ?? []).map((i) => i.tax_label));
  const taxSummaryLabel = distinctTaxLabels.size === 1 ? [...distinctTaxLabels][0] : "Tax";

  return (
    <main className="mx-auto max-w-2xl px-6 py-16" data-testid="bill-detail">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{bill.vendor_name}</h1>
          {/* Due date is the second line, directly under the vendor, at the vendor's own size and
              weight — deliberately NOT folded into the muted metadata line below it, where it used
              to sit as " · due 2026-10-24" and read as an afterthought. It is the single fact that
              decides whether this screen needs acting on today. */}
          <p className={bill.due_date ? "text-xl font-semibold text-zinc-900" : "text-xl font-semibold text-zinc-400"} data-testid="bill-due-date">
            {bill.due_date ? `Due ${bill.due_date}` : "No due date"}
          </p>
          <p className="text-sm text-zinc-500">
            {bill.bill_number}
            {bill.po_number && <span> · PO {bill.po_number}</span>}
            {" · "}
            {bill.currency}
          </p>
          {bill.vendor_address && <p className="mt-2 text-sm text-zinc-500 whitespace-pre-line">{bill.vendor_address}</p>}
          {(bill.vendor_email || bill.vendor_phone) && (
            <p className="text-sm text-zinc-500">{bill.vendor_email || bill.vendor_phone}</p>
          )}
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ${
            bill.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
          }`}
          data-testid="bill-status"
        >
          {bill.status}
          {bill.paid_at ? ` · ${new Date(bill.paid_at).toLocaleDateString()}` : ""}
        </span>
      </div>

      <div className="mb-6 rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-zinc-500">
            <tr>
              <th className="p-3">Description</th>
              <th className="p-3">Qty</th>
              <th className="p-3">Rate</th>
              <th className="p-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lineItems?.map((item, i) => (
              <tr key={i} className="border-b border-zinc-100 last:border-0" data-testid="bill-line-item">
                <td className="p-3">{item.description}</td>
                <td className="p-3">{item.quantity}</td>
                <td className="p-3">{formatAmount(item.unit_price_cents)}</td>
                <td className="p-3 text-right">{formatAmount(item.quantity * item.unit_price_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col gap-1 border-t border-zinc-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Subtotal</span>
            <span>{fmt(bill.subtotal_cents)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">{taxSummaryLabel}</span>
            <span>{fmt(bill.tax_cents)}</span>
          </div>
          <div className="flex justify-between font-semibold" data-testid="bill-total">
            <span>Total</span>
            <span>{fmt(bill.total_cents)}</span>
          </div>
        </div>
      </div>

      {duplicateOf && (
        <p
          className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          data-testid="duplicate-bill-flag"
        >
          <span className="font-medium">Possible duplicate. </span>
          This bill has the same vendor, amount and due date as{" "}
          <Link href={`/bills/${duplicateOf.id}`} className="underline">
            {duplicateOf.bill_number}
          </Link>
          . If it&apos;s the same bill forwarded twice, mark one of them paid or delete it. We
          haven&apos;t assumed either way.
        </p>
      )}

      {/* Only for a bill that can still get one. A paid bill's reminder is spent history, and
          offering to edit it would imply a notification is still coming. */}
      {bill.status !== "paid" && <ReminderEditor bill={bill} />}

      {bill.terms && (
        <p className="mb-6 text-sm text-zinc-600">
          <span className="font-medium">Terms: </span>
          {bill.terms}
        </p>
      )}

      {bill.status === "unpaid" && <MarkPaidButton billId={bill.id} />}
    </main>
  );
}
