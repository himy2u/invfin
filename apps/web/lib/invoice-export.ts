import { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";

// Shared by send (PDF attachment) and the download buttons — one place that assembles the full
// invoice payload the agent's export endpoints expect, so all three stay in sync automatically.
export async function buildExportPayload(supabase: SupabaseClient<Database>, invoiceId: string) {
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select(
      "invoice_number, currency, issue_date, due_date, terms, status, subtotal_cents, tax_cents, total_cents, user_id, clients(name, email, phone, billing_address)",
    )
    .eq("id", invoiceId)
    .single();
  if (invoiceError || !invoice) throw new Error("invoice not found");

  const [{ data: lineItems, error: itemsError }, { data: profile }] = await Promise.all([
    supabase
      .from("invoice_line_items")
      .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label")
      .eq("invoice_id", invoiceId)
      .order("sort_order"),
    supabase
      .from("profiles")
      .select("business_name, business_address, tax_registration_number")
      .eq("user_id", invoice.user_id)
      .maybeSingle(),
  ]);
  if (itemsError) throw itemsError;

  return {
    invoice_number: invoice.invoice_number,
    currency: invoice.currency,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    terms: invoice.terms,
    status: invoice.status,
    subtotal_cents: invoice.subtotal_cents,
    tax_cents: invoice.tax_cents,
    total_cents: invoice.total_cents,
    business: {
      name: profile?.business_name ?? null,
      address: profile?.business_address ?? null,
      tax_registration_number: profile?.tax_registration_number ?? null,
    },
    client: {
      name: invoice.clients?.name ?? null,
      address: invoice.clients?.billing_address ?? null,
      email: invoice.clients?.email ?? null,
      phone: invoice.clients?.phone ?? null,
    },
    line_items: (lineItems ?? []).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price_cents: item.unit_price_cents,
      tax_rate_percent: item.tax_rate_percent,
      tax_label: item.tax_label,
    })),
  };
}
