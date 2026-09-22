"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type LineItem = { description: string; quantity: string; unitPrice: string };
const emptyLineItem: LineItem = { description: "", quantity: "1", unitPrice: "0" };
const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

type ScanResult = {
  document_type: "invoice" | "receipt" | "purchase_order" | "timesheet" | null;
  vendor: string | null;
  vendor_address?: string | null;
  invoice_number: string | null;
  reference_number: string | null;
  line_items: { description: string; quantity: number; unit_price: number }[];
  tax: number;
  total: number | null;
  total_matches_line_items: boolean;
  error?: string;
};

type Product = {
  id: string;
  name: string;
  description: string | null;
  default_price_cents: number;
  default_tax_rate_percent: number;
  default_tax_label: string;
};

type PastVendor = { vendor_name: string; vendor_address: string | null; vendor_email: string | null; vendor_phone: string | null };

export function NewBillForm({
  products,
  defaultCurrency,
  pastVendors,
}: {
  products: Product[];
  defaultCurrency: string;
  pastVendors: PastVendor[];
}) {
  const router = useRouter();
  const supabase = createClient();

  const [vendorName, setVendorName] = useState("");
  const [vendorAddress, setVendorAddress] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [vendorPhone, setVendorPhone] = useState("");
  const [billNumber, setBillNumber] = useState(`BILL-${Date.now().toString().slice(-6)}`);
  const [currency, setCurrency] = useState(defaultCurrency);
  const [dueDate, setDueDate] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [terms, setTerms] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [lineItems, setLineItems] = useState<LineItem[]>([{ ...emptyLineItem }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [scanIsWarning, setScanIsWarning] = useState(false);

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

  async function handleScan(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);
    setScanNotice(null);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/scan-invoice", { method: "POST", body: formData });
      const data: ScanResult = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");

      // Scanning a vendor's own invoice/receipt/PO is the natural way to create a Bill. the
      // "vendor" the extraction prompt identifies as whoever issued the document is exactly who
      // you owe money to here (unlike the invoice form, where the same field feeds "Bill From").
      setVendorName(data.vendor ?? "");
      if (data.vendor_address) setVendorAddress(data.vendor_address);
      if (data.invoice_number) setBillNumber(data.invoice_number);
      if (data.document_type === "purchase_order" && data.reference_number) {
        setPoNumber(data.reference_number);
      }
      if (data.line_items.length > 0) {
        const lineItemsSum = data.line_items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
        const impliedTaxRate = data.tax > 0 && lineItemsSum > 0 ? (data.tax / lineItemsSum) * 100 : 0;
        setTaxRate(String(Math.round(impliedTaxRate * 100) / 100));
        setLineItems(
          data.line_items.map((item) => ({
            description: item.description,
            quantity: String(item.quantity),
            unitPrice: String(item.unit_price),
          })),
        );
      }
      setScanIsWarning(!data.total_matches_line_items);
      setScanNotice(
        data.total_matches_line_items
          ? `Read from ${data.vendor ?? "the"} document. Check the amounts below before creating.`
          : `Read from ${data.vendor ?? "the"} document, but the total didn't match the line items. Double-check the amounts before creating.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: rpcError } = await supabase.rpc("create_bill_with_line_items", {
        p_bill_number: billNumber,
        p_vendor_name: vendorName.trim(),
        p_currency: currency,
        p_issue_date: new Date().toISOString().slice(0, 10),
        p_vendor_address: vendorAddress.trim() || undefined,
        p_vendor_email: vendorEmail.trim() || undefined,
        p_vendor_phone: vendorPhone.trim() || undefined,
        p_due_date: dueDate || undefined,
        p_po_number: poNumber || undefined,
        p_terms: terms || undefined,
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

      router.push("/bills");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create bill");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4">
        <label className="mb-1 block text-sm font-medium text-amber-900">
          Scan the vendor&apos;s invoice, receipt, or PO, pre-fills the form below (optional)
        </label>
        <input
          type="file"
          accept="image/*,.csv,text/csv"
          onChange={handleScan}
          disabled={scanning}
          data-testid="bill-scan-file-input"
          className="text-sm"
        />
        {scanning && <p className="mt-2 text-sm text-amber-700">Reading document…</p>}
        {scanNotice && (
          <p
            className={`mt-2 text-sm ${scanIsWarning ? "font-medium text-amber-800" : "text-amber-700"}`}
            data-testid="bill-scan-notice"
          >
            {scanIsWarning ? "⚠ " : ""}
            {scanNotice}
          </p>
        )}
      </div>

      <div className="relative">
        <label className="mb-1 block text-sm">Vendor name</label>
        <input
          value={vendorName}
          onChange={(e) => setVendorName(e.target.value)}
          required
          placeholder="Start typing to find a vendor you've billed before"
          data-testid="vendor-name-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
        {vendorName.trim().length > 0 &&
          (() => {
            const matches = pastVendors.filter(
              (v) =>
                v.vendor_name.toLowerCase().includes(vendorName.trim().toLowerCase()) &&
                v.vendor_name.trim().toLowerCase() !== vendorName.trim().toLowerCase(),
            );
            if (matches.length === 0) return null;
            return (
              <ul className="mt-1 rounded border border-zinc-200 bg-white shadow-sm" data-testid="vendor-suggestions">
                {matches.map((v) => (
                  <li key={v.vendor_name}>
                    <button
                      type="button"
                      onClick={() => {
                        setVendorName(v.vendor_name);
                        setVendorAddress(v.vendor_address ?? "");
                        setVendorEmail(v.vendor_email ?? "");
                        setVendorPhone(v.vendor_phone ?? "");
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-amber-50"
                      data-testid="vendor-suggestion"
                    >
                      {v.vendor_name}
                    </button>
                  </li>
                ))}
              </ul>
            );
          })()}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <input
          value={vendorEmail}
          onChange={(e) => setVendorEmail(e.target.value)}
          placeholder="Vendor email (optional)"
          className="rounded border border-zinc-300 px-3 py-2"
        />
        <input
          value={vendorPhone}
          onChange={(e) => setVendorPhone(e.target.value)}
          placeholder="Vendor phone (optional)"
          className="rounded border border-zinc-300 px-3 py-2"
        />
      </div>
      <textarea
        value={vendorAddress}
        onChange={(e) => setVendorAddress(e.target.value)}
        placeholder="Vendor address (optional)"
        rows={2}
        data-testid="vendor-address-input"
        className="w-full rounded border border-zinc-300 px-3 py-2"
      />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm">Bill number</label>
          <input
            value={billNumber}
            onChange={(e) => setBillNumber(e.target.value)}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Currency</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
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
          <label className="mb-1 block text-sm">Due date (optional)</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">P.O. number (optional)</label>
          <input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            data-testid="bill-po-input"
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium">
            Line items{" "}
            <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600">
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
                <tr key={i} className="border-b border-zinc-100 last:border-b-0 even:bg-zinc-50/50" data-testid="bill-line-item-row">
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
                      placeholder="Tax name"
                      className="w-28 rounded border border-zinc-300 px-2 py-1 text-right text-xs"
                    />
                    <input
                      type="number"
                      value={taxRate}
                      onChange={(e) => setTaxRate(e.target.value)}
                      placeholder="0"
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
        data-testid="submit-bill-button"
      >
        {submitting ? "Creating…" : "Create bill"}
      </button>
    </form>
  );
}
