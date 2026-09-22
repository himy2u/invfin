"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxLabel: string;
};

const emptyLineItem: LineItem = { description: "", quantity: "1", unitPrice: "0", taxRate: "0", taxLabel: "Tax" };
const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

type ExistingClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  default_currency: string | null;
};

type Product = {
  id: string;
  name: string;
  description: string | null;
  default_price_cents: number;
  default_tax_rate_percent: number;
  default_tax_label: string;
};

export function NewEstimateForm({
  existingClients,
  products,
  defaultCurrency,
}: {
  existingClients: ExistingClient[];
  products: Product[];
  defaultCurrency: string;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [clientId, setClientId] = useState("");
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [estimateNumber, setEstimateNumber] = useState(`EST-${Date.now().toString().slice(-6)}`);
  const [validUntil, setValidUntil] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [terms, setTerms] = useState("");
  const [depositRequested, setDepositRequested] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [lineItems, setLineItems] = useState<LineItem[]>([{ ...emptyLineItem }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateLineItem(index: number, field: keyof LineItem, value: string) {
    setLineItems((items) => items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function removeLineItem(index: number) {
    setLineItems((items) => (items.length > 1 ? items.filter((_, i) => i !== index) : items));
  }

  function addFromCatalog(productId: string) {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    if (taxRate === "0" && product.default_tax_rate_percent > 0) {
      setTaxRate(String(product.default_tax_rate_percent));
      setTaxLabel(product.default_tax_label);
    }
    const newLine: LineItem = {
      description: product.description ? `${product.name}: ${product.description}` : product.name,
      quantity: "1",
      unitPrice: (product.default_price_cents / 100).toString(),
      taxRate: "0",
      taxLabel: "Tax",
    };
    setLineItems((items) => {
      const isFirstRowEmpty = items.length === 1 && !items[0].description && items[0].unitPrice === "0";
      return isFirstRowEmpty ? [newLine] : [...items, newLine];
    });
  }

  function lineAmount(item: LineItem) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    return (qty * price).toFixed(2);
  }

  const subtotal = lineItems.reduce((sum, item) => sum + Number(lineAmount(item)), 0);
  const tax = subtotal * ((Number(taxRate) || 0) / 100);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      let finalClientId = clientId;

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("not signed in");
      const user = session.user;

      if (!finalClientId && newClientName.trim()) {
        if (!newClientEmail.trim() && !newClientPhone.trim()) {
          throw new Error("client needs an email or phone");
        }

        // Reuse an existing client matched by name or email instead of creating a duplicate —
        // same check as the invoice form.
        const trimmedName = newClientName.trim().toLowerCase();
        const trimmedEmail = newClientEmail.trim().toLowerCase();
        const duplicate = existingClients.find(
          (c) => c.name.trim().toLowerCase() === trimmedName || (trimmedEmail && c.email?.toLowerCase() === trimmedEmail),
        );

        if (duplicate) {
          finalClientId = duplicate.id;
        } else {
          const { data: client, error: clientError } = await supabase
            .from("clients")
            .insert({
              user_id: user.id,
              name: newClientName.trim(),
              email: newClientEmail.trim() || null,
              phone: newClientPhone.trim() || null,
            })
            .select("id")
            .single();
          if (clientError) throw clientError;
          finalClientId = client.id;
        }
      }

      if (!finalClientId) throw new Error("select or create a client");

      const { data: estimateId, error: rpcError } = await supabase.rpc("create_estimate_with_line_items", {
        p_client_id: finalClientId,
        p_estimate_number: estimateNumber,
        p_currency: currency,
        p_issue_date: new Date().toISOString().slice(0, 10),
        p_valid_until: validUntil || undefined,
        p_terms: terms || undefined,
        p_title: title || undefined,
        p_summary: summary || undefined,
        p_deposit_requested_cents: depositRequested ? Math.round(Number(depositRequested) * 100) : undefined,
        p_line_items: lineItems.map((item) => ({
          description: item.description,
          quantity: Number(item.quantity),
          unit_price_cents: Math.round(Number(item.unitPrice) * 100),
          tax_rate_percent: Number(taxRate) || 0,
          tax_label: taxLabel || "Tax",
          discount_cents: 0,
        })),
      });
      if (rpcError) throw rpcError;

      router.push(`/estimates/${estimateId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create estimate");
    } finally {
      setSubmitting(false);
    }
  }

  const clientMatches =
    !clientId && newClientName.trim().length > 0
      ? existingClients.filter((c) => c.name.toLowerCase().includes(newClientName.trim().toLowerCase()))
      : [];

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div>
        <label className="mb-1 block text-sm">Client</label>
        {clientId ? (
          <div className="flex items-center justify-between rounded border border-teal-200 bg-teal-50 px-3 py-2">
            <span className="text-sm" data-testid="selected-client">
              {existingClients.find((c) => c.id === clientId)?.name} (saved client)
            </span>
            <button type="button" onClick={() => setClientId("")} className="text-sm text-teal-700 underline">
              Change
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              placeholder="Search or type a new client name"
              data-testid="new-client-name"
              className="w-full rounded border border-zinc-300 px-3 py-2"
              autoComplete="off"
            />
            {clientMatches.length > 0 && (
              <ul className="rounded border border-zinc-200 bg-white shadow-sm" data-testid="client-suggestions">
                {clientMatches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setClientId(c.id);
                        setNewClientName("");
                        if (c.default_currency) setCurrency(c.default_currency);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-teal-50"
                      data-testid="client-suggestion"
                    >
                      {c.name}
                      {c.email ? ` · ${c.email}` : c.phone ? ` · ${c.phone}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              value={newClientEmail}
              onChange={(e) => setNewClientEmail(e.target.value)}
              placeholder="Client email (or phone below)"
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
            <input
              value={newClientPhone}
              onChange={(e) => setNewClientPhone(e.target.value)}
              placeholder="Client phone (or email above)"
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm">Estimate number</label>
          <input
            value={estimateNumber}
            onChange={(e) => setEstimateNumber(e.target.value)}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Currency</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            data-testid="currency-select"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm">Valid until (optional)</label>
          <input
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            data-testid="valid-until-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Request deposit (optional)</label>
          <input
            type="number"
            value={depositRequested}
            onChange={(e) => setDepositRequested(e.target.value)}
            placeholder="e.g. 500"
            data-testid="deposit-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm">Title (optional)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Estimate"
          data-testid="estimate-title-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm">Summary (optional)</label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          data-testid="estimate-summary-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium">
            Line items{" "}
            <span
              className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600"
              data-testid="line-item-count"
            >
              {lineItems.length}
            </span>
          </label>
          <div className="flex items-center gap-3">
            {products.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addFromCatalog(e.target.value);
                  e.target.value = "";
                }}
                data-testid="add-from-catalog-select"
                className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-600"
              >
                <option value="">+ Add from catalog…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setLineItems((items) => [...items, { ...emptyLineItem }])}
              className="text-sm text-teal-700 underline"
            >
              + Add line
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded border border-zinc-300">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-300 bg-zinc-50 text-xs font-medium text-zinc-500">
                <th className="w-10 px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Description</th>
                <th className="w-20 px-2 py-2 text-left">Qty</th>
                <th className="w-24 px-2 py-2 text-left">Rate</th>
                <th className="w-28 px-2 py-2 text-right">Amount</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => (
                <tr key={i} className="border-b border-zinc-100 last:border-b-0 even:bg-zinc-50/50" data-testid="line-item-row">
                  <td className="px-2 py-1.5 text-zinc-400">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <input
                      placeholder="Description"
                      value={item.description}
                      onChange={(e) => updateLineItem(i, "description", e.target.value)}
                      required
                      className="w-full rounded border border-zinc-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      placeholder="Qty"
                      value={item.quantity}
                      onChange={(e) => updateLineItem(i, "quantity", e.target.value)}
                      className="w-full rounded border border-zinc-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      placeholder="Rate"
                      value={item.unitPrice}
                      onChange={(e) => updateLineItem(i, "unitPrice", e.target.value)}
                      className="w-full rounded border border-zinc-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium text-zinc-700">{lineAmount(item)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => removeLineItem(i)}
                      disabled={lineItems.length === 1}
                      aria-label={`Remove line ${i + 1}`}
                      className="text-zinc-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-300 bg-zinc-50 text-sm">
                <td colSpan={3} className="px-2 py-2 text-right font-medium text-zinc-600">
                  Subtotal
                </td>
                <td className="px-2 py-2 text-right font-medium text-zinc-700">{subtotal.toFixed(2)}</td>
                <td />
              </tr>
              <tr className="text-sm">
                <td colSpan={3} className="px-2 py-2 text-right align-middle">
                  <div className="flex items-center justify-end gap-2">
                    <input
                      value={taxLabel}
                      onChange={(e) => setTaxLabel(e.target.value)}
                      placeholder="HST, GST, VAT…"
                      data-testid="estimate-tax-label"
                      className="w-28 rounded border border-zinc-300 px-2 py-1 text-right text-xs"
                    />
                    <input
                      type="number"
                      value={taxRate}
                      onChange={(e) => setTaxRate(e.target.value)}
                      placeholder="0"
                      data-testid="estimate-tax-rate"
                      className="w-16 rounded border border-zinc-300 px-2 py-1 text-right text-xs"
                    />
                    <span className="text-zinc-500">%</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right font-medium text-zinc-700">{tax.toFixed(2)}</td>
                <td />
              </tr>
              <tr className="border-t border-zinc-300 text-sm">
                <td colSpan={3} className="px-2 py-2 text-right font-semibold text-zinc-800">
                  Total
                </td>
                <td className="px-2 py-2 text-right font-semibold text-zinc-900">{(subtotal + tax).toFixed(2)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm">Terms / notes</label>
        <textarea
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-teal-700 px-4 py-2 text-white hover:bg-teal-800 disabled:opacity-50"
        data-testid="submit-estimate-button"
      >
        {submitting ? "Creating…" : "Create estimate"}
      </button>
    </form>
  );
}
