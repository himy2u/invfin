"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

export function BusinessProfileForm({
  userId,
  initial,
}: {
  userId: string;
  initial: {
    businessName: string;
    businessAddress: string;
    taxRegistrationNumber: string;
    defaultCurrency: string;
  };
}) {
  const supabase = createClient();
  const [businessName, setBusinessName] = useState(initial.businessName);
  const [businessAddress, setBusinessAddress] = useState(initial.businessAddress);
  const [taxRegistrationNumber, setTaxRegistrationNumber] = useState(initial.taxRegistrationNumber);
  const [defaultCurrency, setDefaultCurrency] = useState(initial.defaultCurrency);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);

    const { error } = await supabase.from("profiles").upsert({
      user_id: userId,
      business_name: businessName.trim() || null,
      business_address: businessAddress.trim() || null,
      tax_registration_number: taxRegistrationNumber.trim() || null,
      default_currency: defaultCurrency,
    });

    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSaved(true);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-sm">Business name</label>
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          data-testid="business-name-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm">Business address</label>
        <textarea
          value={businessAddress}
          onChange={(e) => setBusinessAddress(e.target.value)}
          rows={3}
          data-testid="business-address-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm">Tax registration number (optional)</label>
        <input
          value={taxRegistrationNumber}
          onChange={(e) => setTaxRegistrationNumber(e.target.value)}
          placeholder="e.g. GST/HST #, VAT number, EIN"
          data-testid="tax-registration-input"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm">Default currency</label>
        <select
          value={defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
          data-testid="default-currency-select"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-500">Pre-fills the currency on new invoices.</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        data-testid="save-profile-button"
        className="self-start rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saved && (
        <p className="text-sm text-teal-700" data-testid="profile-saved">
          ✓ Saved
        </p>
      )}
    </div>
  );
}
