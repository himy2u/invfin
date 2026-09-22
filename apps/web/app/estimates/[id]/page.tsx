import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ConvertButton } from "./convert-button";

export default async function EstimateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: estimate } = await supabase
    .from("estimates")
    .select(
      "id, estimate_number, status, currency, subtotal_cents, tax_cents, total_cents, title, summary, valid_until, terms, deposit_requested_cents, converted_invoice_id, user_id, clients(name, email, phone, billing_address)",
    )
    .eq("id", id)
    .single();

  if (!estimate) notFound();

  const [{ data: lineItems }, { data: profile }] = await Promise.all([
    supabase
      .from("estimate_line_items")
      .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label, sort_order")
      .eq("estimate_id", id)
      .order("sort_order"),
    supabase
      .from("profiles")
      .select("business_name, business_address")
      .eq("user_id", estimate.user_id)
      .maybeSingle(),
  ]);

  const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${estimate.currency}`;
  const distinctTaxLabels = new Set((lineItems ?? []).map((i) => i.tax_label));
  const taxSummaryLabel = distinctTaxLabels.size === 1 ? [...distinctTaxLabels][0] : "Tax";

  return (
    <main className="mx-auto max-w-2xl px-6 py-16" data-testid="estimate-detail">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{estimate.title || "Estimate"}</h1>
          <p className="text-sm text-zinc-500">
            {estimate.estimate_number}
            {estimate.valid_until && <span> · valid until {estimate.valid_until}</span>}
            {" · "}
            {estimate.currency}
          </p>
          {estimate.summary && <p className="mt-2 text-sm text-zinc-600">{estimate.summary}</p>}

          <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium text-zinc-400">From</p>
              <p className="text-zinc-700">{profile?.business_name ?? "Your business (not set)"}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-400">For</p>
              <p className="text-zinc-700">{estimate.clients?.name}</p>
              <p className="text-zinc-500">{estimate.clients?.email ?? estimate.clients?.phone}</p>
            </div>
          </div>
        </div>
        <span
          className="whitespace-nowrap rounded-full bg-sky-100 px-3 py-1 text-sm font-medium text-sky-800"
          data-testid="estimate-status"
        >
          {estimate.status}
        </span>
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
              <tr key={i} className="border-b border-zinc-100 last:border-0" data-testid="estimate-line-item">
                <td className="p-3">{item.description}</td>
                <td className="p-3">{item.quantity}</td>
                <td className="p-3">{(item.unit_price_cents / 100).toFixed(2)}</td>
                <td className="p-3">
                  {item.tax_rate_percent > 0 ? `${item.tax_label} ${item.tax_rate_percent}%` : "-"}
                </td>
                <td className="p-3 text-right">{((item.quantity * item.unit_price_cents) / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col gap-1 border-t border-zinc-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Subtotal</span>
            <span>{fmt(estimate.subtotal_cents)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">{taxSummaryLabel}</span>
            <span>{fmt(estimate.tax_cents)}</span>
          </div>
          <div className="flex justify-between font-semibold" data-testid="estimate-total">
            <span>Total</span>
            <span>{fmt(estimate.total_cents)}</span>
          </div>
          {estimate.deposit_requested_cents != null && (
            <div className="flex justify-between text-amber-700">
              <span>Deposit requested</span>
              <span>{fmt(estimate.deposit_requested_cents)}</span>
            </div>
          )}
        </div>
      </div>

      {estimate.terms && (
        <p className="mb-6 text-sm text-zinc-600">
          <span className="font-medium">Terms: </span>
          {estimate.terms}
        </p>
      )}

      {estimate.converted_invoice_id ? (
        <a
          href={`/invoices/${estimate.converted_invoice_id}`}
          className="inline-block rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800"
          data-testid="view-converted-invoice"
        >
          View converted invoice →
        </a>
      ) : (
        <ConvertButton estimateId={estimate.id} />
      )}
    </main>
  );
}
