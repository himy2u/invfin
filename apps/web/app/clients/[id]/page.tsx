import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClientEditForm, type Contact } from "./client-edit-form";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select(
      "id, name, email, phone, billing_address, account_number, website, private_notes, additional_contacts, default_currency",
    )
    .eq("id", id)
    .single();

  if (!client) notFound();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-6 text-xl font-semibold">{client.name}</h1>
      <ClientEditForm
        client={{
          ...client,
          // additional_contacts is stored as jsonb — cast the empty-array default from Postgres to
          // the typed shape the form expects rather than trusting arbitrary Json.
          additional_contacts: (client.additional_contacts as Contact[] | null) ?? [],
        }}
      />
    </main>
  );
}
