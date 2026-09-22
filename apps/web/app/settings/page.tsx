import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BusinessProfileForm } from "./business-profile-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("business_name, business_address, tax_registration_number, default_currency")
    .eq("user_id", user!.id)
    .maybeSingle();
  const { data: forwardingAddress } = await supabase
    .from("email_forwarding_addresses")
    .select("enabled")
    .eq("user_id", user!.id)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-xl font-semibold">Business info</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Shown as the &quot;from&quot; details on every invoice you create.
      </p>
      <Link href="/settings/products" className="mb-6 inline-block text-sm text-teal-700 underline">
        Manage products and services →
      </Link>
      <BusinessProfileForm
        userId={user!.id}
        initial={{
          businessName: profile?.business_name ?? "",
          businessAddress: profile?.business_address ?? "",
          taxRegistrationNumber: profile?.tax_registration_number ?? "",
          defaultCurrency: profile?.default_currency ?? "USD",
        }}
      />

      <div className="mt-8 flex items-center justify-between rounded-lg border border-zinc-200 p-4">
        <div>
          <p className="text-sm font-semibold">Automatic bill detection</p>
          <p className="text-xs text-zinc-500">
            {forwardingAddress?.enabled ? "Connected — forwarding is active." : "Not connected yet."}
          </p>
        </div>
        <Link href="/connect-email" className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
          {forwardingAddress?.enabled ? "Manage" : "Set up"}
        </Link>
      </div>
    </main>
  );
}
