import { createClient } from "@/lib/supabase/server";
import { NewBillForm } from "./new-bill-form";

export default async function NewBillPage() {
  const supabase = await createClient();

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

  // Vendors aren't a separate reusable entity (a bill's vendor fields are a plain snapshot, not a
  // foreign key). but the user should still be able to pick a vendor they've billed before
  // instead of retyping the name/address/email/phone every time. Dedupe past bills by vendor name,
  // most-recent details winning.
  const { data: pastBills } = await supabase
    .from("bills")
    .select("vendor_name, vendor_address, vendor_email, vendor_phone")
    .order("created_at", { ascending: false })
    .limit(100);
  const seenVendors = new Set<string>();
  const pastVendors = (pastBills ?? []).filter((b) => {
    const key = b.vendor_name.trim().toLowerCase();
    if (seenVendors.has(key)) return false;
    seenVendors.add(key);
    return true;
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-1 text-xl font-semibold">New bill</h1>
      <p className="mb-6 text-sm text-zinc-500">
        A bill is money you owe a vendor, the mirror of an invoice, which is money owed to you.
      </p>
      <NewBillForm
        products={products ?? []}
        defaultCurrency={profile?.default_currency ?? "USD"}
        pastVendors={pastVendors}
      />
    </main>
  );
}
