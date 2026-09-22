import { createClient } from "@/lib/supabase/server";
import { ProductsManager } from "./products-manager";

export default async function ProductsPage() {
  const supabase = await createClient();
  const { data: products } = await supabase
    .from("products")
    .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label, sku")
    .order("name");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-xl font-semibold">Products and services</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Save a price, description, and tax once, then pick it from the catalog when building an invoice
        instead of retyping it every time.
      </p>
      <ProductsManager initialProducts={products ?? []} />
    </main>
  );
}
