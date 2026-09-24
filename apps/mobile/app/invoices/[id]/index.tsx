import { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Link, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { supabase } from "../../../lib/supabase";
import { buildExportPayload } from "../../../lib/invoice-export";
import { saveAndShare } from "../../../lib/download-and-share";

type InvoiceDetail = {
  id: string;
  invoice_number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  sent_at: string | null;
  due_date: string | null;
  terms: string | null;
  title: string | null;
  summary: string | null;
  po_number: string | null;
  user_id: string;
  clients: { id: string; name: string; email: string | null; phone: string | null; billing_address: string | null } | null;
};

type LineItem = {
  description: string;
  quantity: number;
  unit_price_cents: number;
  tax_rate_percent: number;
  tax_label: string;
};

type Profile = { business_name: string | null; business_address: string | null; tax_registration_number: string | null };

type VersionEntry = {
  version_number: number;
  created_at: string;
  snapshot: { invoice: { total_cents: number }; line_items: unknown[] };
};

const UNEDITABLE_STATUSES = ["paid", "partially_paid", "void"];

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [downloading, setDownloading] = useState<"pdf" | "csv" | null>(null);

  async function handleDownload(format: "pdf" | "csv") {
    if (!invoice) return;
    setDownloading(format);
    setError(null);
    try {
      const payload = await buildExportPayload(supabase, invoice.id);
      const agentUrl = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/generate-invoice-${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${format} export failed`);

      const bytes = await res.arrayBuffer();
      const mimeType = format === "pdf" ? "application/pdf" : "text/csv";
      await saveAndShare(bytes, `${payload.invoice_number}.${format}`, mimeType);
    } catch (err) {
      setError(err instanceof Error ? err.message : "download failed");
    } finally {
      setDownloading(null);
    }
  }

  const load = useCallback(() => {
    setLoading(true);
    supabase
      .from("invoices")
      .select(
        "id, invoice_number, status, currency, subtotal_cents, tax_cents, total_cents, amount_paid_cents, sent_at, due_date, terms, title, summary, po_number, user_id, clients(id, name, email, phone, billing_address)",
      )
      .eq("id", id)
      .single()
      .then(({ data }) => {
        const inv = data as InvoiceDetail | null;
        setInvoice(inv);
        setLoading(false);
        if (inv) {
          supabase
            .from("profiles")
            .select("business_name, business_address, tax_registration_number")
            .eq("user_id", inv.user_id)
            .maybeSingle()
            .then(({ data }) => setProfile(data));
        }
      });
    supabase
      .from("invoice_line_items")
      .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label")
      .eq("invoice_id", id)
      .order("sort_order")
      .then(({ data }) => setLineItems(data ?? []));
    supabase
      .from("invoice_versions")
      .select("version_number, snapshot, created_at")
      .eq("invoice_id", id)
      .order("version_number", { ascending: false })
      .then(({ data }) => setVersions((data as VersionEntry[]) ?? []));
  }, [id]);

  useFocusEffect(load);

  async function handleSend() {
    if (!invoice) return;
    setSending(true);
    setError(null);

    try {
      const exportPayload = await buildExportPayload(supabase, invoice.id);
      const clientEmail = exportPayload.client.email;
      if (!clientEmail) throw new Error("this client has no email on file");

      const agentUrl = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/send-invoice-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: clientEmail,
          invoice_number: exportPayload.invoice_number,
          total_formatted: (exportPayload.total_cents / 100).toFixed(2),
          currency: exportPayload.currency,
          export: exportPayload,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? "send failed");
      }

      const { error: updateError } = await supabase
        .from("invoices")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", invoice.id);
      if (updateError) throw new Error("email sent, but failed to update status");

      setSent(true);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setSending(false);
    }
  }

  if (loading || !invoice) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Invoice" }} />
        <Text>Loading…</Text>
      </View>
    );
  }

  const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${invoice.currency}`;
  const distinctTaxLabels = new Set(lineItems.map((i) => i.tax_label));
  const taxSummaryLabel = distinctTaxLabels.size === 1 ? [...distinctTaxLabels][0] : "Tax";

  return (
    <ScrollView style={styles.container} testID="invoice-detail-screen">
      <Stack.Screen options={{ title: invoice.invoice_number }} />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{invoice.title || "Invoice"}</Text>
          {/* Second line, at the title's own size and weight — same rule as the bill detail screen.
              This header previously did not show the due date at all. */}
          <Text style={invoice.due_date ? styles.dueDate : styles.dueDateMissing} testID="invoice-due-date">
            {invoice.due_date ? `Due ${invoice.due_date}` : "No due date"}
          </Text>
          <Text style={styles.subtitle}>
            {invoice.invoice_number}
            {invoice.po_number ? <Text testID="invoice-po-number"> · PO {invoice.po_number}</Text> : null}
            {" · "}
            {invoice.currency}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <Text style={styles.statusBadge} testID="invoice-status">
            {invoice.status}
          </Text>
          {!UNEDITABLE_STATUSES.includes(invoice.status) && (
            <Link href={`/invoices/${invoice.id}/edit`} testID="edit-invoice-link">
              <Text style={styles.editLink}>Edit</Text>
            </Link>
          )}
        </View>
      </View>
      {invoice.summary && (
        <Text style={styles.summaryText} testID="invoice-summary">
          {invoice.summary}
        </Text>
      )}

      <View style={styles.addressRow}>
        <View style={styles.addressCol} testID="bill-from">
          <Text style={styles.addressLabel}>From</Text>
          <Text style={styles.addressName}>{profile?.business_name ?? "Your business (not set)"}</Text>
          {profile?.business_address && <Text style={styles.addressText}>{profile.business_address}</Text>}
          {profile?.tax_registration_number && (
            <Text style={styles.addressText}>Tax ID: {profile.tax_registration_number}</Text>
          )}
        </View>
        <View style={styles.addressCol} testID="bill-to">
          <Text style={styles.addressLabel}>Bill to</Text>
          <Text style={styles.addressName}>{invoice.clients?.name}</Text>
          <Text style={styles.addressText}>{invoice.clients?.email ?? invoice.clients?.phone}</Text>
          {invoice.clients?.billing_address && (
            <Text style={styles.addressText} testID="client-address">
              {invoice.clients.billing_address}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.lineItemHeader}>
        <Text style={[styles.columnHeader, { flex: 2 }]}>Description</Text>
        <Text style={[styles.columnHeader, styles.colQty]}>Qty</Text>
        <Text style={[styles.columnHeader, styles.colRate]}>Rate</Text>
        <Text style={[styles.columnHeader, styles.colTax]}>Tax</Text>
        <Text style={[styles.columnHeader, styles.colAmount]}>Amount</Text>
      </View>
      {lineItems.map((item, i) => (
        <View key={i} style={styles.lineItemRow} testID="detail-line-item">
          <Text style={{ flex: 2 }}>{item.description}</Text>
          <Text style={styles.colQty}>{item.quantity}</Text>
          <Text style={styles.colRate}>{(item.unit_price_cents / 100).toFixed(2)}</Text>
          <Text style={[styles.colTax, { fontSize: 11 }]}>
            {item.tax_rate_percent > 0 ? `${item.tax_label} ${item.tax_rate_percent}%` : "-"}
          </Text>
          <Text style={[styles.colAmount, { fontWeight: "600" }]}>
            {((item.quantity * item.unit_price_cents) / 100).toFixed(2)}
          </Text>
        </View>
      ))}

      <View style={styles.totals}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Subtotal</Text>
          <Text>{fmt(invoice.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{taxSummaryLabel}</Text>
          <Text>{fmt(invoice.tax_cents)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabelBold}>Total</Text>
          <Text style={styles.totalLabelBold} testID="detail-total">
            {fmt(invoice.total_cents)}
          </Text>
        </View>
      </View>

      <View style={styles.exportRow}>
        <Pressable
          style={styles.exportButton}
          onPress={() => handleDownload("pdf")}
          disabled={downloading !== null}
          testID="download-pdf-button"
        >
          <Text style={styles.exportButtonText}>{downloading === "pdf" ? "…" : "Download PDF"}</Text>
        </Pressable>
        <Pressable
          style={styles.exportButton}
          onPress={() => handleDownload("csv")}
          disabled={downloading !== null}
          testID="download-csv-button"
        >
          <Text style={styles.exportButtonText}>{downloading === "csv" ? "…" : "Download CSV"}</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {!invoice.clients?.email ? (
        <View>
          <Text style={styles.warn}>This client has no email on file, can&apos;t send.</Text>
          {invoice.clients?.id && (
            <Link href={`/clients/${invoice.clients.id}`} testID="add-client-email-link">
              <Text style={styles.editLink}>Add an email →</Text>
            </Link>
          )}
        </View>
      ) : invoice.status !== "draft" || sent ? (
        <Text style={styles.sent} testID="send-confirmation">
          ✓ Sent
        </Text>
      ) : (
        <Pressable style={styles.button} onPress={handleSend} disabled={sending} testID="send-invoice-button">
          <Text style={styles.buttonText}>{sending ? "Sending…" : "Send invoice"}</Text>
        </Pressable>
      )}

      {versions.length > 0 && (
        <View style={styles.historySection}>
          <Text style={styles.historyTitle}>Edit history</Text>
          {versions.map((v) => (
            <View key={v.version_number} style={styles.historyRow} testID="edit-history-entry">
              <Text style={styles.historyText}>
                Version {v.version_number} · {new Date(v.created_at).toLocaleString()}
              </Text>
              <Text style={styles.historyText}>
                was {(v.snapshot.invoice.total_cents / 100).toFixed(2)} {invoice.currency},{" "}
                {v.snapshot.line_items.length} line item{v.snapshot.line_items.length === 1 ? "" : "s"}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  // Same size and weight as `title` on purpose — the due date carries equal billing with the name.
  dueDate: { fontSize: 20, fontWeight: "700", color: "#18181b", marginTop: 2 },
  dueDateMissing: { fontSize: 20, fontWeight: "600", color: "#a1a1aa", marginTop: 2 },
  subtitle: { fontSize: 13, color: "#71717a", marginTop: 2 },
  summaryText: { fontSize: 13, color: "#3f3f46", marginBottom: 12 },
  statusBadge: { backgroundColor: "#ccfbf1", color: "#115e59", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, fontWeight: "600" },
  addressRow: { flexDirection: "row", gap: 16, marginBottom: 16 },
  addressCol: { flex: 1 },
  addressLabel: { fontSize: 11, color: "#a1a1aa", fontWeight: "600" },
  addressName: { fontSize: 13, color: "#3f3f46", marginTop: 2 },
  addressText: { fontSize: 12, color: "#71717a", marginTop: 1 },
  exportRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  exportButton: { flex: 1, borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  exportButtonText: { fontSize: 13, color: "#3f3f46" },
  lineItemHeader: { flexDirection: "row", gap: 8, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: "#e4e4e7" },
  columnHeader: { fontSize: 11, fontWeight: "600", color: "#a1a1aa" },
  colQty: { width: 30, textAlign: "right" },
  colRate: { width: 50, textAlign: "right" },
  colTax: { width: 70, textAlign: "right" },
  colAmount: { width: 60, textAlign: "right" },
  lineItemRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f4f4f5" },
  totals: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#e4e4e7", gap: 4 },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { color: "#71717a" },
  totalLabelBold: { fontWeight: "700" },
  error: { color: "#dc2626", marginTop: 12 },
  warn: { color: "#b45309", marginTop: 16 },
  sent: { color: "#0f766e", marginTop: 16, fontWeight: "600" },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 16 },
  buttonText: { color: "#fff", fontWeight: "600" },
  editLink: { color: "#0f766e", textDecorationLine: "underline", fontSize: 13 },
  historySection: { marginTop: 24, marginBottom: 40, borderTopWidth: 1, borderTopColor: "#e4e4e7", paddingTop: 12 },
  historyTitle: { fontSize: 13, fontWeight: "700", color: "#3f3f46", marginBottom: 8 },
  historyRow: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 8, padding: 10, marginBottom: 8 },
  historyText: { fontSize: 12, color: "#71717a" },
});
