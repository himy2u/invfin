import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PendingReviewSection } from "./pending-review-section";

const STATUS_STYLES: Record<string, string> = {
  unpaid: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
};

export default async function BillsPage() {
  const supabase = await createClient();
  const { data: bills } = await supabase
    .from("bills")
    .select("id, bill_number, status, total_cents, currency, vendor_name, due_date, reminder_mode, reminder_offset_value, reminder_offset_unit, reminder_at")
    .order("created_at", { ascending: false });

  // pending_review/dismissed are deliberately excluded here by filtering on the literal "unpaid"
  // status. see the migration comment on why review state reuses bill_status instead of a
  // parallel column: an AI-guessed, unconfirmed bill must never count toward "what you owe."
  const unpaid = (bills ?? []).filter((b) => b.status === "unpaid");
  const unpaidTotal = unpaid.reduce((sum, b) => sum + b.total_cents, 0);
  const pendingReview = (bills ?? []).filter((b) => b.status === "pending_review");
  const visibleBills = (bills ?? []).filter((b) => b.status !== "pending_review" && b.status !== "dismissed");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Bills</h1>
        <div className="flex gap-4">
          <Link href="/dashboard" className="text-sm text-teal-700 underline">
            ← Dashboard
          </Link>
          <Link href="/invoices" className="text-sm text-teal-700 underline">
            Invoices
          </Link>
          <Link
            href="/bills/new"
            className="rounded bg-teal-700 px-3 py-1.5 text-sm text-white hover:bg-teal-800"
            data-testid="create-bill-button"
          >
            + New bill
          </Link>
        </div>
      </div>

      <PendingReviewSection bills={pendingReview} />

      {unpaid.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="unpaid-summary">
          <p className="text-sm text-amber-800">
            <span className="font-semibold">{(unpaidTotal / 100).toFixed(2)}</span> unpaid across{" "}
            {unpaid.length} bill{unpaid.length === 1 ? "" : "s"}
          </p>
        </div>
      )}

      {visibleBills.length === 0 && (
        <p className="text-sm text-zinc-500" data-testid="no-bills">
          No bills yet. A bill is money you owe a vendor (the mirror of an invoice, which is money
          owed to you).
        </p>
      )}

      <div className="flex flex-col gap-2">
        {visibleBills.map((b) => (
          <Link
            key={b.id}
            href={`/bills/${b.id}`}
            className="flex items-center justify-between rounded border border-zinc-200 p-3 hover:bg-zinc-50"
            data-testid="bill-row"
          >
            <div>
              <p className="text-sm font-medium">{b.vendor_name}</p>
              <p className="text-xs text-zinc-500">
                {b.bill_number}
                {b.due_date ? ` · due ${b.due_date}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[b.status] ?? "bg-zinc-100 text-zinc-700"}`}>
                {b.status}
              </span>
              <span className="text-sm font-medium">
                {(b.total_cents / 100).toFixed(2)} {b.currency}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
