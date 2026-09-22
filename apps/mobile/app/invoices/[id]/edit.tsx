import { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../../../lib/supabase";

type LineItem = { description: string; quantity: string; unitPrice: string; taxRate: string; taxLabel: string; discount: string };

export default function EditInvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState("USD");
  const [dueDate, setDueDate] = useState("");
  const [terms, setTerms] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      supabase
        .from("invoices")
        .select("currency, due_date, terms, title, summary, po_number, status")
        .eq("id", id)
        .single()
        .then(({ data }) => {
          if (cancelled || !data) return;
          if (["paid", "partially_paid", "void"].includes(data.status)) {
            router.replace(`/invoices/${id}`);
            return;
          }
          setCurrency(data.currency);
          setDueDate(data.due_date ?? "");
          setTerms(data.terms ?? "");
          setTitle(data.title ?? "");
          setSummary(data.summary ?? "");
          setPoNumber(data.po_number ?? "");
        });
      supabase
        .from("invoice_line_items")
        .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label, discount_cents")
        .eq("invoice_id", id)
        .order("sort_order")
        .then(({ data }) => {
          if (cancelled) return;
          if (data && data.length > 0) {
            setTaxRate(String(data[0].tax_rate_percent));
            setTaxLabel(data[0].tax_label);
          }
          setLineItems(
            (data ?? []).map((item) => ({
              description: item.description,
              quantity: String(item.quantity),
              unitPrice: (item.unit_price_cents / 100).toString(),
              taxRate: "0",
              taxLabel: "Tax",
              discount: (item.discount_cents / 100).toString(),
            })),
          );
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [id, router]),
  );

  function updateLineItem(index: number, field: keyof LineItem, value: string) {
    setLineItems((items) => items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function removeLineItem(index: number) {
    setLineItems((items) => (items.length > 1 ? items.filter((_, i) => i !== index) : items));
  }

  function lineAmount(item: LineItem) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    return (qty * price).toFixed(2);
  }

  const subtotal = lineItems.reduce((sum, item) => sum + Number(lineAmount(item)), 0);
  const tax = subtotal * ((Number(taxRate) || 0) / 100);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const { error: rpcError } = await supabase.rpc("update_invoice_with_line_items", {
        p_invoice_id: id,
        p_due_date: dueDate || undefined,
        p_terms: terms || undefined,
        p_title: title || undefined,
        p_summary: summary || undefined,
        p_po_number: poNumber || undefined,
        p_line_items: lineItems.map((item) => ({
          description: item.description,
          quantity: Number(item.quantity),
          unit_price_cents: Math.round(Number(item.unitPrice) * 100),
          tax_rate_percent: Number(taxRate) || 0,
          tax_label: taxLabel || "Tax",
          discount_cents: Math.round(Number(item.discount || "0") * 100),
        })),
      });
      if (rpcError) throw rpcError;
      router.replace(`/invoices/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Edit invoice" }} />
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} testID="edit-invoice-screen">
      <Text style={styles.label}>Due date</Text>
      <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" />

      <Text style={styles.label}>P.O./S.O. number (optional)</Text>
      <TextInput style={styles.input} value={poNumber} onChangeText={setPoNumber} testID="po-number-input" />

      <Text style={styles.label}>Invoice title (optional)</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} testID="invoice-title-input" />

      <Text style={styles.label}>Summary (optional)</Text>
      <TextInput style={styles.input} value={summary} onChangeText={setSummary} multiline testID="invoice-summary-input" />

      <View style={styles.lineItemsHeader}>
        <Text style={styles.label}>
          Line items <Text style={styles.lineItemCount}>{lineItems.length}</Text>
        </Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
        <View>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.tableHeaderCell, styles.colIndex]}>#</Text>
            <Text style={[styles.tableHeaderCell, styles.colDescription]}>Description</Text>
            <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, styles.colRate]}>Rate</Text>
            <Text style={[styles.tableHeaderCell, styles.colAmount, styles.textRight]}>Amount</Text>
            <View style={styles.colRemove} />
          </View>
          {lineItems.map((item, i) => (
            <View key={i} style={styles.tableDataRow} testID="line-item-row">
              <Text style={[styles.tableIndexText, styles.colIndex]}>{i + 1}</Text>
              <TextInput
                style={[styles.input, styles.tableCellInput, styles.colDescription]}
                value={item.description}
                onChangeText={(v) => updateLineItem(i, "description", v)}
              />
              <TextInput
                style={[styles.input, styles.tableCellInput, styles.colQty]}
                value={item.quantity}
                onChangeText={(v) => updateLineItem(i, "quantity", v)}
                keyboardType="numeric"
              />
              <TextInput
                style={[styles.input, styles.tableCellInput, styles.colRate]}
                value={item.unitPrice}
                onChangeText={(v) => updateLineItem(i, "unitPrice", v)}
                keyboardType="numeric"
              />
              <Text style={[styles.tableAmountText, styles.colAmount]}>{lineAmount(item)}</Text>
              <Pressable style={styles.colRemove} onPress={() => removeLineItem(i)} disabled={lineItems.length === 1} hitSlop={8}>
                <Text style={[styles.removeText, lineItems.length === 1 && styles.removeTextDisabled]}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
      <Pressable
        onPress={() =>
          setLineItems((items) => [
            ...items,
            { description: "", quantity: "1", unitPrice: "0", taxRate: "0", taxLabel: "Tax", discount: "0" },
          ])
        }
      >
        <Text style={styles.link}>+ Add line</Text>
      </Pressable>

      <View style={styles.summaryBox}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal</Text>
          <Text style={styles.summaryValue}>
            {subtotal.toFixed(2)} {currency}
          </Text>
        </View>
        <View style={styles.summaryRow}>
          <View style={styles.taxInputRow}>
            <TextInput
              style={[styles.input, styles.taxLabelInput]}
              placeholder="HST, GST, VAT…"
              value={taxLabel}
              onChangeText={setTaxLabel}
              testID="invoice-tax-label"
            />
            <TextInput
              style={[styles.input, styles.taxRateInput]}
              value={taxRate}
              onChangeText={setTaxRate}
              keyboardType="numeric"
              testID="invoice-tax-rate"
            />
            <Text style={styles.summaryLabel}>%</Text>
          </View>
          <Text style={styles.summaryValue}>
            {tax.toFixed(2)} {currency}
          </Text>
        </View>
        <View style={[styles.summaryRow, styles.summaryTotalRow]}>
          <Text style={styles.summaryTotalLabel}>Total</Text>
          <Text style={styles.summaryTotalValue}>
            {(subtotal + tax).toFixed(2)} {currency}
          </Text>
        </View>
      </View>

      <Text style={styles.label}>Terms / notes</Text>
      <TextInput style={styles.input} value={terms} onChangeText={setTerms} multiline />

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 16, marginBottom: 40 }}>
        <Pressable style={[styles.button, { flex: 1 }]} onPress={handleSave} disabled={saving} testID="save-invoice-edit-button">
          <Text style={styles.buttonText}>{saving ? "Saving…" : "Save changes"}</Text>
        </Pressable>
        <Pressable style={styles.cancelButton} onPress={() => router.push(`/invoices/${id}`)}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  label: { fontSize: 13, color: "#71717a", marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, padding: 10 },
  lineItemsHeader: { marginTop: 16 },
  lineItemCount: { fontSize: 12, fontWeight: "600", color: "#0f766e", backgroundColor: "#f0fdfa", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: "hidden" },
  tableScroll: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, marginTop: 4 },
  tableHeaderRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#fafafa", borderBottomWidth: 1, borderBottomColor: "#e4e4e7", paddingVertical: 6, paddingHorizontal: 6 },
  tableHeaderCell: { fontSize: 11, fontWeight: "600", color: "#a1a1aa", textTransform: "uppercase" },
  tableDataRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: "#f4f4f5" },
  tableCellInput: { paddingVertical: 6, paddingHorizontal: 6, marginHorizontal: 2, textAlign: "left" },
  tableAmountText: { textAlign: "right", fontSize: 13, color: "#3f3f46", fontWeight: "700", paddingRight: 6 },
  tableIndexText: { fontSize: 12, color: "#a1a1aa", textAlign: "center" },
  colIndex: { width: 20 },
  colDescription: { width: 140 },
  colQty: { width: 50 },
  colRate: { width: 70 },
  colAmount: { width: 70 },
  colRemove: { width: 30, alignItems: "center" },
  textRight: { textAlign: "right" },
  removeText: { fontSize: 15, color: "#dc2626", fontWeight: "600" },
  removeTextDisabled: { color: "#d4d4d8" },
  link: { color: "#0f766e", textDecorationLine: "underline", marginTop: 8 },
  summaryBox: { marginTop: 16, borderTopWidth: 1, borderTopColor: "#e4e4e7", paddingTop: 10, gap: 4 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  taxInputRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  taxLabelInput: { paddingVertical: 4, paddingHorizontal: 8, fontSize: 12, width: 100 },
  taxRateInput: { paddingVertical: 4, paddingHorizontal: 8, fontSize: 12, width: 50, textAlign: "right" },
  summaryLabel: { fontSize: 13, color: "#71717a" },
  summaryValue: { fontSize: 13, color: "#3f3f46", fontWeight: "500" },
  summaryTotalRow: { borderTopWidth: 1, borderTopColor: "#e4e4e7", paddingTop: 6, marginTop: 2 },
  summaryTotalLabel: { fontSize: 14, fontWeight: "700", color: "#18181b" },
  summaryTotalValue: { fontSize: 14, fontWeight: "700", color: "#18181b" },
  error: { color: "#dc2626", marginTop: 12 },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600" },
  cancelButton: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, padding: 14, alignItems: "center", paddingHorizontal: 20 },
  cancelButtonText: { color: "#3f3f46", fontWeight: "600" },
});
