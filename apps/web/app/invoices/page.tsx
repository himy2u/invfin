import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  sent: "bg-sky-100 text-sky-800",
  partially_paid: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  void: "bg-zinc-100 text-zinc-400 line-through",
};

export default async function InvoicesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, total_cents, currency, clients(name)")
    .order("created_at", { ascending: false });

  const all = invoices ?? [];
  // Real numbers computed from what's actually in the DB — not placeholder stats for a dashboard
  // feature (aging/outstanding tracking) that Phase 3 hasn't built yet.
  const outstanding = all.filter((i) => i.status === "draft" || i.status === "sent");
  const outstandingTotal = outstanding.reduce((sum, i) => sum + i.total_cents, 0);
  const sentCount = all.filter((i) => i.status !== "draft").length;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="mb-1 text-sm text-zinc-500">Signed in as {user?.email}</p>
          <h1 className="text-2xl font-semibold text-zinc-900">Invoices</h1>
        </div>
        <div className="flex gap-4">
          <Link href="/dashboard" className="text-sm text-teal-700 underline" data-testid="dashboard-link">
            ← Dashboard
          </Link>
          <Link href="/estimates" className="text-sm text-teal-700 underline" data-testid="estimates-link">
            Estimates
          </Link>
          <Link href="/bills" className="text-sm text-teal-700 underline" data-testid="bills-link">
            Bills
          </Link>
          <Link href="/clients" className="text-sm text-teal-700 underline" data-testid="clients-link">
            Clients
          </Link>
          <Link href="/settings" className="text-sm text-teal-700 underline" data-testid="settings-link">
            Business info
          </Link>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Link
          href="/invoices/new"
          className="flex flex-col items-center gap-2 rounded-xl bg-teal-50 p-5 text-center hover:bg-teal-100"
          data-testid="create-invoice-tile"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-700 text-xl text-white">
            +
          </span>
          <span className="font-medium text-teal-900">Create invoice</span>
          <span className="text-xs text-teal-700">Manual, scan, or describe it</span>
        </Link>
        <Link
          href="/invoices/new"
          className="flex flex-col items-center gap-2 rounded-xl bg-amber-50 p-5 text-center hover:bg-amber-100"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-600 text-xl text-white">
            📷
          </span>
          <span className="font-medium text-amber-900">Scan a photo</span>
          <span className="text-xs text-amber-700">Invoice, receipt, or PO</span>
        </Link>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-zinc-200 p-4" data-testid="stat-outstanding">
          <p className="text-xs text-zinc-500">Outstanding</p>
          <p className="text-xl font-semibold">{(outstandingTotal / 100).toFixed(2)}</p>
          <p className="text-xs text-zinc-400">{outstanding.length} invoice{outstanding.length === 1 ? "" : "s"}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 p-4" data-testid="stat-sent">
          <p className="text-xs text-zinc-500">Sent</p>
          <p className="text-xl font-semibold">{sentCount}</p>
          <p className="text-xs text-zinc-400">of {all.length} total</p>
        </div>
      </div>

      {all.length === 0 ? (
        <p className="text-zinc-500" data-testid="empty-state">
          No invoices yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="invoice-list">
          {all.map((invoice) => (
            <li key={invoice.id}>
              <Link
                href={`/invoices/${invoice.id}`}
                className="flex items-center justify-between rounded-xl border border-zinc-200 px-4 py-3 hover:border-teal-300 hover:bg-teal-50"
                data-testid="invoice-row"
              >
                <div>
                  <p className="font-medium text-zinc-900">{invoice.clients?.name ?? "Unknown client"}</p>
                  <p className="text-xs text-zinc-500">{invoice.invoice_number}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[invoice.status] ?? "bg-zinc-100 text-zinc-700"}`}
                  >
                    {invoice.status}
                  </span>
                  <span className="font-medium">
                    {(invoice.total_cents / 100).toFixed(2)} {invoice.currency}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
