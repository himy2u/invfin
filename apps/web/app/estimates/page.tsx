import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  sent: "bg-sky-100 text-sky-800",
  accepted: "bg-emerald-100 text-emerald-800",
  declined: "bg-red-100 text-red-700",
  expired: "bg-amber-100 text-amber-800",
  converted: "bg-teal-100 text-teal-800",
};

export default async function EstimatesPage() {
  const supabase = await createClient();
  const { data: estimates } = await supabase
    .from("estimates")
    .select("id, estimate_number, status, total_cents, currency, valid_until, clients(name)")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Estimates</h1>
        <div className="flex gap-4">
          <Link href="/invoices" className="text-sm text-teal-700 underline">
            ← Invoices
          </Link>
          <Link
            href="/estimates/new"
            className="rounded bg-teal-700 px-3 py-1.5 text-sm text-white hover:bg-teal-800"
            data-testid="create-estimate-button"
          >
            + New estimate
          </Link>
        </div>
      </div>

      {(!estimates || estimates.length === 0) && (
        <p className="text-sm text-zinc-500" data-testid="no-estimates">
          No estimates yet.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {estimates?.map((e) => (
          <Link
            key={e.id}
            href={`/estimates/${e.id}`}
            className="flex items-center justify-between rounded border border-zinc-200 p-3 hover:bg-zinc-50"
            data-testid="estimate-row"
          >
            <div>
              <p className="text-sm font-medium">{e.clients?.name ?? "Unknown client"}</p>
              <p className="text-xs text-zinc-500">
                {e.estimate_number}
                {e.valid_until ? ` · valid until ${e.valid_until}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[e.status] ?? "bg-zinc-100 text-zinc-700"}`}>
                {e.status}
              </span>
              <span className="text-sm font-medium">
                {(e.total_cents / 100).toFixed(2)} {e.currency}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
