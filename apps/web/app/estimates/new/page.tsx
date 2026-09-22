import { createClient } from "@/lib/supabase/server";
import { NewEstimateForm } from "./new-estimate-form";

export default async function NewEstimatePage() {
  const supabase = await createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, email, phone, billing_address, default_currency")
    .order("name");

  const { data: products } = await supabase
    .from("products")
    .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label")
    .order("name");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("profiles").select("default_currency").eq("user_id", user.id).maybeSingle()
    : { data: null };

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-6 text-xl font-semibold">New estimate</h1>
      <NewEstimateForm
        existingClients={clients ?? []}
        products={products ?? []}
        defaultCurrency={profile?.default_currency ?? "USD"}
      />
    </main>
  );
}
