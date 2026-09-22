"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Product = {
  id: string;
  name: string;
  description: string | null;
  default_price_cents: number;
  default_tax_rate_percent: number;
  default_tax_label: string;
  sku: string | null;
};

export function ProductsManager({ initialProducts }: { initialProducts: Product[] }) {
  const supabase = createClient();
  const [products, setProducts] = useState(initialProducts);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [sku, setSku] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);

    if (products.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      setError(`"${name.trim()}" is already in your catalog. Edit or delete the existing one instead of adding a duplicate.`);
      return;
    }

    setSaving(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setError("not signed in");
      setSaving(false);
      return;
    }
    const user = session.user;

    const { data, error: insertError } = await supabase
      .from("products")
      .insert({
        user_id: user.id,
        name: name.trim(),
        description: description.trim() || null,
        default_price_cents: Math.round(Number(price) * 100) || 0,
        default_tax_label: taxLabel.trim() || "Tax",
        default_tax_rate_percent: Number(taxRate) || 0,
        sku: sku.trim() || null,
      })
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label, sku")
      .single();

    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setProducts((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    setName("");
    setDescription("");
    setPrice("");
    setTaxLabel("Tax");
    setTaxRate("0");
    setSku("");
  }

  async function handleDelete(id: string) {
    await supabase.from("products").delete().eq("id", id);
    setProducts((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleAdd} className="flex flex-col gap-3 rounded border border-zinc-200 p-4">
        <div>
          <label className="mb-1 block text-sm">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="product-name-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Description (optional)</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="product-description-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-sm">Default price</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              data-testid="product-price-input"
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm">Tax name</label>
            <input
              value={taxLabel}
              onChange={(e) => setTaxLabel(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm">Tax %</label>
            <input
              type="number"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm">SKU (optional)</label>
          <input
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            data-testid="product-sku-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          data-testid="add-product-button"
          className="self-start rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add product"}
        </button>
      </form>

      <div className="flex flex-col gap-2">
        {products.length === 0 && (
          <p className="text-sm text-zinc-500" data-testid="no-products">
            No products yet.
          </p>
        )}
        {products.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between rounded border border-zinc-200 p-3"
            data-testid="product-row"
          >
            <div>
              <p className="text-sm font-medium">{p.name}</p>
              {p.description && <p className="text-xs text-zinc-500">{p.description}</p>}
              <p className="text-xs text-zinc-500">
                {(p.default_price_cents / 100).toFixed(2)}
                {p.default_tax_rate_percent > 0 ? ` + ${p.default_tax_label} ${p.default_tax_rate_percent}%` : ""}
                {p.sku ? ` · SKU ${p.sku}` : ""}
              </p>
            </div>
            <button
              onClick={() => handleDelete(p.id)}
              data-testid="delete-product-button"
              className="text-sm text-red-600 hover:underline"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
