"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Contact = { name: string; email: string; phone: string };

type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  account_number: string | null;
  website: string | null;
  private_notes: string | null;
  additional_contacts: Contact[];
  default_currency: string | null;
};

const CURRENCIES = ["", "USD", "CAD", "EUR", "GBP", "AUD", "INR"];
const emptyContact: Contact = { name: "", email: "", phone: "" };

export function ClientEditForm({ client }: { client: Client }) {
  const supabase = createClient();
  const [name, setName] = useState(client.name);
  const [email, setEmail] = useState(client.email ?? "");
  const [phone, setPhone] = useState(client.phone ?? "");
  const [billingAddress, setBillingAddress] = useState(client.billing_address ?? "");
  const [accountNumber, setAccountNumber] = useState(client.account_number ?? "");
  const [website, setWebsite] = useState(client.website ?? "");
  const [privateNotes, setPrivateNotes] = useState(client.private_notes ?? "");
  const [defaultCurrency, setDefaultCurrency] = useState(client.default_currency ?? "");
  const [contacts, setContacts] = useState<Contact[]>(client.additional_contacts ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateContact(i: number, field: keyof Contact, value: string) {
    setContacts((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);

    const { error } = await supabase
      .from("clients")
      .update({
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        billing_address: billingAddress.trim() || null,
        account_number: accountNumber.trim() || null,
        website: website.trim() || null,
        private_notes: privateNotes.trim() || null,
        default_currency: defaultCurrency || null,
        additional_contacts: contacts.filter((c) => c.name.trim() || c.email.trim() || c.phone.trim()),
      })
      .eq("id", client.id);

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
        <label className="mb-1 block text-sm">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="client-edit-name"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm">Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Phone</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-sm">Billing address</label>
        <textarea
          value={billingAddress}
          onChange={(e) => setBillingAddress(e.target.value)}
          rows={2}
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="mb-1 block text-sm">Account number</label>
          <input
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
            placeholder="Private, not shown on invoices"
            data-testid="client-account-number"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Website</label>
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            data-testid="client-website"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Currency</label>
          <select
            value={defaultCurrency}
            onChange={(e) => setDefaultCurrency(e.target.value)}
            data-testid="client-default-currency"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c || "Use business default"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm">Private notes</label>
        <textarea
          value={privateNotes}
          onChange={(e) => setPrivateNotes(e.target.value)}
          rows={2}
          placeholder="Only you can see this, never shown on invoices"
          data-testid="client-private-notes"
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium">Additional contacts</label>
          <button
            type="button"
            onClick={() => setContacts((prev) => [...prev, { ...emptyContact }])}
            className="text-sm text-teal-700 underline"
            data-testid="add-contact-button"
          >
            + Add contact
          </button>
        </div>
        {contacts.map((c, i) => (
          <div key={i} className="mb-2 grid grid-cols-3 gap-2" data-testid="additional-contact-row">
            <input
              placeholder="Name"
              value={c.name}
              onChange={(e) => updateContact(i, "name", e.target.value)}
              className="rounded border border-zinc-300 px-2 py-1 text-sm"
            />
            <input
              placeholder="Email"
              value={c.email}
              onChange={(e) => updateContact(i, "email", e.target.value)}
              className="rounded border border-zinc-300 px-2 py-1 text-sm"
            />
            <input
              placeholder="Phone"
              value={c.phone}
              onChange={(e) => updateContact(i, "phone", e.target.value)}
              className="rounded border border-zinc-300 px-2 py-1 text-sm"
            />
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        data-testid="save-client-button"
        className="self-start rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saved && (
        <p className="text-sm text-teal-700" data-testid="client-saved">
          ✓ Saved
        </p>
      )}
    </div>
  );
}
