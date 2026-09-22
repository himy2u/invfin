import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, FlatList } from "react-native";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { supabase } from "../../lib/supabase";
import { colors, spacing, radius, cardShadow } from "../../lib/theme";

type LineItem = { description: string; quantity: string; unitPrice: string };
const emptyLineItem: LineItem = { description: "", quantity: "1", unitPrice: "0" };
const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

type Product = { id: string; name: string; description: string | null; default_price_cents: number; default_tax_rate_percent: number; default_tax_label: string };

type PastVendor = { vendor_name: string; vendor_address: string | null; vendor_email: string | null; vendor_phone: string | null };

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

export default function NewBillScreen() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [pastVendors, setPastVendors] = useState<PastVendor[]>([]);
  const [vendorName, setVendorName] = useState("");
  const [vendorAddress, setVendorAddress] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [vendorPhone, setVendorPhone] = useState("");
  const [billNumber, setBillNumber] = useState(`BILL-${Date.now().toString().slice(-6)}`);
  const [currency, setCurrency] = useState("USD");
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

  useEffect(() => {
    supabase
      .from("products")
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label")
      .order("name")
      .then(({ data }) => setProducts(data ?? []));
    supabase
      .from("bills")
      .select("vendor_name, vendor_address, vendor_email, vendor_phone")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => {
        const seen = new Set<string>();
        const deduped = (data ?? []).filter((b) => {
          const key = b.vendor_name.trim().toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setPastVendors(deduped);
      });
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      supabase
        .from("profiles")
        .select("default_currency")
        .eq("user_id", session.user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.default_currency) setCurrency(data.default_currency);
        });
    });
  }, []);

  function updateLineItem(index: number, field: keyof LineItem, value: string) {
    setLineItems((items) => items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function removeLineItem(index: number) {
    setLineItems((items) => (items.length > 1 ? items.filter((_, i) => i !== index) : items));
  }

  function addFromCatalog(product: Product) {
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

  async function pickDocumentAndScan() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "text/csv", "text/comma-separated-values", "application/vnd.ms-excel"],
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];

    setScanning(true);
    setScanNotice(null);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", {
        uri: asset.uri,
        name: asset.name || "document.jpg",
        type: asset.mimeType || "image/jpeg",
      } as unknown as Blob);

      const agentUrl = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/scan-invoice`, { method: "POST", body: formData });
      const data: ScanResult = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");

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

  async function handleSubmit() {
    setError(null);
    if (!vendorName.trim()) {
      setError("vendor name is required");
      return;
    }
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
      router.replace("/bills");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create bill");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} testID="new-bill-screen">
      <View style={styles.scanBox}>
        <Text style={styles.scanLabel}>Scan the vendor&apos;s invoice, receipt, or PO (optional)</Text>
        <Pressable style={styles.scanButton} onPress={pickDocumentAndScan} disabled={scanning} testID="bill-scan-button">
          <Text style={styles.scanButtonText}>{scanning ? "Reading…" : "📄 Choose document"}</Text>
        </Pressable>
        {scanNotice && (
          <Text style={[styles.scanNotice, scanIsWarning && styles.scanWarning]} testID="bill-scan-notice">
            {scanIsWarning ? "⚠ " : ""}
            {scanNotice}
          </Text>
        )}
      </View>

      <Text style={styles.label}>Vendor name</Text>
      <TextInput
        style={styles.input}
        value={vendorName}
        onChangeText={setVendorName}
        placeholder="Start typing to find a vendor you've billed before"
        testID="vendor-name-input"
      />
      {(() => {
        const matches = pastVendors.filter(
          (v) =>
            vendorName.trim().length > 0 &&
            v.vendor_name.toLowerCase().includes(vendorName.trim().toLowerCase()) &&
            v.vendor_name.trim().toLowerCase() !== vendorName.trim().toLowerCase(),
        );
        if (matches.length === 0) return null;
        return (
          <FlatList
            testID="vendor-suggestions"
            data={matches}
            keyExtractor={(v) => v.vendor_name}
            style={styles.suggestions}
            renderItem={({ item }) => (
              <Pressable
                testID="vendor-suggestion"
                style={styles.suggestionRow}
                onPress={() => {
                  setVendorName(item.vendor_name);
                  setVendorAddress(item.vendor_address ?? "");
                  setVendorEmail(item.vendor_email ?? "");
                  setVendorPhone(item.vendor_phone ?? "");
                }}
              >
                <Text>{item.vendor_name}</Text>
              </Pressable>
            )}
          />
        );
      })()}

      <Text style={styles.label}>Vendor email (optional)</Text>
      <TextInput style={styles.input} value={vendorEmail} onChangeText={setVendorEmail} autoCapitalize="none" />

      <Text style={styles.label}>Vendor phone (optional)</Text>
      <TextInput style={styles.input} value={vendorPhone} onChangeText={setVendorPhone} keyboardType="phone-pad" />

      <Text style={styles.label}>Vendor address (optional)</Text>
      <TextInput style={styles.input} value={vendorAddress} onChangeText={setVendorAddress} multiline testID="vendor-address-input" />

      <Text style={styles.label}>Bill number</Text>
      <TextInput style={styles.input} value={billNumber} onChangeText={setBillNumber} />

      <Text style={styles.label}>Currency</Text>
      <View style={styles.currencyRow}>
        {CURRENCIES.map((c) => (
          <Pressable key={c} onPress={() => setCurrency(c)} style={[styles.currencyChip, currency === c && styles.currencyChipSelected]}>
            <Text style={[styles.currencyChipText, currency === c && styles.currencyChipTextSelected]}>{c}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Due date (optional)</Text>
      <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" />

      <Text style={styles.label}>P.O. number (optional)</Text>
      <TextInput style={styles.input} value={poNumber} onChangeText={setPoNumber} testID="bill-po-input" />

      <View style={styles.lineItemsHeader}>
        <Text style={styles.label}>
          Line items <Text style={styles.lineItemCount}>{lineItems.length}</Text>
        </Text>
      </View>

      {products.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {products.map((p) => (
              <Pressable key={p.id} onPress={() => addFromCatalog(p)} style={styles.catalogChip}>
                <Text style={styles.catalogChipText}>+ {p.name}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}

      {lineItems.map((item, i) => (
        <View key={i} style={styles.lineItemCard} testID="bill-line-item-row">
          <View style={styles.lineItemCardHeader}>
            <Text style={styles.lineItemIndex}>Item {i + 1}</Text>
            <Pressable onPress={() => removeLineItem(i)} disabled={lineItems.length === 1} hitSlop={8}>
              <Text style={[styles.removeText, lineItems.length === 1 && styles.removeTextDisabled]}>Remove</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.input}
            placeholder="Description"
            value={item.description}
            onChangeText={(v) => updateLineItem(i, "description", v)}
            testID="bill-line-item-description"
          />
          <View style={styles.lineItemFieldsRow}>
            <View style={styles.lineItemFieldQty}>
              <Text style={styles.fieldLabel}>Qty</Text>
              <TextInput style={styles.input} value={item.quantity} onChangeText={(v) => updateLineItem(i, "quantity", v)} keyboardType="numeric" />
            </View>
            <View style={styles.lineItemFieldRate}>
              <Text style={styles.fieldLabel}>Rate</Text>
              <TextInput style={styles.input} value={item.unitPrice} onChangeText={(v) => updateLineItem(i, "unitPrice", v)} keyboardType="numeric" testID="bill-line-item-price" />
            </View>
            <View style={styles.lineItemFieldAmount}>
              <Text style={styles.fieldLabel}>Amount</Text>
              <Text style={styles.lineItemAmountValue}>{lineAmount(item)}</Text>
            </View>
          </View>
        </View>
      ))}
      <Pressable style={styles.addLineButton} onPress={() => setLineItems((items) => [...items, { ...emptyLineItem }])}>
        <Text style={styles.addLineButtonText}>+ Add line</Text>
      </Pressable>

      <View style={styles.summaryBox}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal</Text>
          <Text style={styles.summaryValue}>{subtotal.toFixed(2)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <View style={styles.taxInputRow}>
            <TextInput style={styles.taxLabelInput} placeholder="Tax name" value={taxLabel} onChangeText={setTaxLabel} />
            <View style={styles.taxRateGroup}>
              <TextInput style={styles.taxRateInput} value={taxRate} onChangeText={setTaxRate} keyboardType="numeric" />
              <Text style={styles.summaryLabel}>%</Text>
            </View>
          </View>
          <Text style={styles.summaryValue}>{tax.toFixed(2)}</Text>
        </View>
        <View style={[styles.summaryRow, styles.summaryTotalRow]}>
          <Text style={styles.summaryTotalLabel}>Total</Text>
          <Text style={styles.summaryTotalValue}>{(subtotal + tax).toFixed(2)}</Text>
        </View>
      </View>

      <Text style={styles.label}>Terms / notes</Text>
      <TextInput style={styles.input} value={terms} onChangeText={setTerms} multiline />

      {error && <Text style={styles.error} testID="new-bill-error">{error}</Text>}

      <Pressable style={styles.button} onPress={handleSubmit} disabled={submitting} testID="submit-bill-button">
        <Text style={styles.buttonText}>{submitting ? "Creating…" : "Create bill"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  scanBox: { borderWidth: 1, borderStyle: "dashed", borderColor: "#fcd34d", backgroundColor: "#fffbeb", borderRadius: 8, padding: 12, marginBottom: 16 },
  scanLabel: { fontSize: 13, fontWeight: "600", color: "#78350f", marginBottom: 8 },
  scanButton: { backgroundColor: "#b45309", borderRadius: 8, padding: 10, alignItems: "center" },
  scanButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  scanNotice: { fontSize: 13, color: "#92400e", marginTop: 8 },
  scanWarning: { color: "#b45309", fontWeight: "700" },
  label: { fontSize: 13, color: "#71717a", marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 11, backgroundColor: colors.surface, fontSize: 15, color: colors.textPrimary },
  suggestions: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 8, marginTop: 4, maxHeight: 150 },
  suggestionRow: { padding: 10, borderBottomWidth: 1, borderBottomColor: "#f4f4f5" },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  currencyChip: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  currencyChipSelected: { backgroundColor: "#0f766e", borderColor: "#0f766e" },
  currencyChipText: { fontSize: 13, color: "#3f3f46", fontWeight: "600" },
  currencyChipTextSelected: { color: "#fff" },
  catalogChip: { borderWidth: 1, borderColor: "#5eead4", backgroundColor: "#f0fdfa", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  catalogChipText: { fontSize: 12, color: "#0f766e", fontWeight: "600" },
  lineItemsHeader: { marginTop: 16 },
  lineItemCount: { fontSize: 12, fontWeight: "600", color: "#0f766e", backgroundColor: "#f0fdfa", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: "hidden" },
  lineItemCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, gap: spacing.sm, ...cardShadow },
  lineItemCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  lineItemIndex: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4 },
  lineItemFieldsRow: { flexDirection: "row", gap: spacing.sm },
  lineItemFieldQty: { width: 64 },
  lineItemFieldRate: { flex: 1 },
  lineItemFieldAmount: { flex: 1, alignItems: "flex-end" },
  lineItemAmountValue: { paddingVertical: 11, fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  fieldLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 4, fontWeight: "600" },
  addLineButton: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.brandBorder,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    backgroundColor: colors.brandLight,
  },
  addLineButtonText: { color: colors.brandDark, fontWeight: "700", fontSize: 13 },
  removeText: { fontSize: 12, color: "#dc2626", fontWeight: "700" },
  removeTextDisabled: { color: "#d4d4d8" },
  link: { color: "#0f766e", textDecorationLine: "underline", marginTop: 8 },
  summaryBox: { marginTop: spacing.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.lg, gap: spacing.xs, ...cardShadow },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  taxInputRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1 },
  taxLabelInput: { fontSize: 13, color: colors.textSecondary, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.borderStrong, minWidth: 70 },
  taxRateGroup: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 4, backgroundColor: colors.surface },
  taxRateInput: { fontSize: 13, color: colors.textPrimary, width: 28, textAlign: "right", padding: 0 },
  summaryLabel: { fontSize: 13, color: "#71717a" },
  summaryValue: { fontSize: 13, color: "#3f3f46", fontWeight: "500" },
  summaryTotalRow: { borderTopWidth: 1, borderTopColor: "#e4e4e7", paddingTop: 6, marginTop: 2 },
  summaryTotalLabel: { fontSize: 14, fontWeight: "700", color: "#18181b" },
  summaryTotalValue: { fontSize: 14, fontWeight: "700", color: "#18181b" },
  error: { color: "#dc2626", marginTop: 12 },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24, marginBottom: 40 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
