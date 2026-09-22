import { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { confirmAsync } from "../../lib/confirm";

type EstimateDetail = {
  id: string;
  estimate_number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  title: string | null;
  summary: string | null;
  valid_until: string | null;
  deposit_requested_cents: number | null;
  converted_invoice_id: string | null;
  clients: { name: string; email: string | null; phone: string | null } | null;
};

type LineItem = { description: string; quantity: number; unit_price_cents: number; tax_rate_percent: number; tax_label: string };

export default function EstimateDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    supabase
      .from("estimates")
      .select(
        "id, estimate_number, status, currency, subtotal_cents, tax_cents, total_cents, title, summary, valid_until, deposit_requested_cents, converted_invoice_id, clients(name, email, phone)",
      )
      .eq("id", id)
      .single()
      .then(({ data }) => {
        setEstimate(data as EstimateDetail | null);
        setLoading(false);
      });
    supabase
      .from("estimate_line_items")
      .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label")
      .eq("estimate_id", id)
      .order("sort_order")
      .then(({ data }) => setLineItems(data ?? []));
  }, [id]);

  useFocusEffect(load);

  async function confirmConvert() {
    // One-way action (the RPC rejects converting the same estimate twice) sitting right below the
    // totals block — a natural scroll-and-tap zone — so a mis-tap needs a confirm step.
    const confirmed = await confirmAsync(
      "Convert to invoice?",
      "This creates a new invoice from this estimate and can't be undone.",
    );
    if (confirmed) handleConvert();
  }

  async function handleConvert() {
    if (!estimate) return;
    setConverting(true);
    setError(null);
    try {
      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
      const { data: invoiceId, error: rpcError } = await supabase.rpc("convert_estimate_to_invoice", {
        p_estimate_id: estimate.id,
        p_invoice_number: invoiceNumber,
      });
      if (rpcError) throw rpcError;
      router.replace(`/invoices/${invoiceId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "conversion failed");
      setConverting(false);
    }
  }

  if (loading || !estimate) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Estimate" }} />
        <Text>Loading…</Text>
      </View>
    );
  }

  const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${estimate.currency}`;

  return (
    <ScrollView style={styles.container} testID="estimate-detail-screen">
      <Stack.Screen options={{ title: estimate.estimate_number }} />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{estimate.title || "Estimate"}</Text>
          <Text style={styles.subtitle}>
            {estimate.estimate_number}
            {estimate.valid_until ? ` · valid until ${estimate.valid_until}` : ""} · {estimate.currency}
          </Text>
        </View>
        <Text style={styles.statusBadge} testID="estimate-status">
          {estimate.status}
        </Text>
      </View>
      {estimate.summary && <Text style={styles.summaryText}>{estimate.summary}</Text>}

      <Text style={styles.forLabel}>For {estimate.clients?.name}</Text>

      {lineItems.map((item, i) => (
        <View key={i} style={styles.lineItemRow} testID="estimate-line-item">
          <Text style={{ flex: 1 }}>{item.description}</Text>
          <Text style={styles.amount}>{((item.quantity * item.unit_price_cents) / 100).toFixed(2)}</Text>
        </View>
      ))}

      <View style={styles.totals}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Subtotal</Text>
          <Text>{fmt(estimate.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Tax</Text>
          <Text>{fmt(estimate.tax_cents)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabelBold}>Total</Text>
          <Text style={styles.totalLabelBold} testID="estimate-total">
            {fmt(estimate.total_cents)}
          </Text>
        </View>
        {estimate.deposit_requested_cents != null && (
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: "#b45309" }]}>Deposit requested</Text>
            <Text style={{ color: "#b45309" }}>{fmt(estimate.deposit_requested_cents)}</Text>
          </View>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {estimate.converted_invoice_id ? (
        <Pressable
          style={styles.button}
          onPress={() => router.push(`/invoices/${estimate.converted_invoice_id}`)}
          testID="view-converted-invoice"
        >
          <Text style={styles.buttonText}>View converted invoice →</Text>
        </Pressable>
      ) : (
        <Pressable style={styles.button} onPress={confirmConvert} disabled={converting} testID="convert-to-invoice-button">
          <Text style={styles.buttonText}>{converting ? "Converting…" : "Convert to invoice"}</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  title: { fontSize: 20, fontWeight: "600" },
  subtitle: { fontSize: 13, color: "#71717a", marginTop: 2 },
  summaryText: { fontSize: 13, color: "#3f3f46", marginBottom: 12 },
  statusBadge: { backgroundColor: "#e0f2fe", color: "#075985", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, fontWeight: "600" },
  forLabel: { fontSize: 12, color: "#a1a1aa", fontWeight: "600", marginTop: 8, marginBottom: 8 },
  lineItemRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f4f4f5" },
  amount: { fontWeight: "600" },
  totals: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#e4e4e7", gap: 4 },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { color: "#71717a" },
  totalLabelBold: { fontWeight: "700" },
  error: { color: "#dc2626", marginTop: 12 },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24, marginBottom: 40 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
