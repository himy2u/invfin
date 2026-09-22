import { createClient } from "@/lib/supabase/server";
import { NewInvoiceForm } from "./new-invoice-form";

export default async function NewInvoicePage() {
  const supabase = await createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, email, phone, billing_address, default_currency")
    .order("name");

  // Only need enough to label the template picker and pull line items on selection — the full
  // invoice is refetched by id once the user actually picks one, not loaded upfront.
  const { data: pastInvoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, clients(name)")
    .order("created_at", { ascending: false })
    .limit(25);

  const { data: products } = await supabase
    .from("products")
    .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label")
    .order("name");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("default_currency, business_name, business_address, tax_registration_number")
        .eq("user_id", user.id)
        .maybeSingle()
    : { data: null };

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-6 text-xl font-semibold">New invoice</h1>
      <NewInvoiceForm
        existingClients={clients ?? []}
        pastInvoices={pastInvoices ?? []}
        defaultCurrency={profile?.default_currency ?? "USD"}
        products={products ?? []}
        initialBusinessProfile={{
          businessName: profile?.business_name ?? "",
          businessAddress: profile?.business_address ?? "",
          taxRegistrationNumber: profile?.tax_registration_number ?? "",
        }}
      />
    </main>
  );
}
