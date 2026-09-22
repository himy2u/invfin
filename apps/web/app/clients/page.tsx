import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function ClientsPage() {
  const supabase = await createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, email, phone")
    .order("name");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Link href="/invoices" className="text-sm text-teal-700 underline">
          ← Invoices
        </Link>
      </div>

      {(!clients || clients.length === 0) && (
        <p className="text-sm text-zinc-500" data-testid="no-clients">
          No clients yet. Clients are created automatically the first time you invoice them.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {clients?.map((c) => (
          <Link
            key={c.id}
            href={`/clients/${c.id}`}
            className="rounded border border-zinc-200 p-3 hover:bg-zinc-50"
            data-testid="client-row"
          >
            <p className="text-sm font-medium">{c.name}</p>
            <p className="text-xs text-zinc-500">{c.email ?? c.phone}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
