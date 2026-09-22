import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, FlatList } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors, spacing, radius, cardShadow } from "../../lib/theme";

type LineItem = { description: string; quantity: string; unitPrice: string; taxRate: string; taxLabel: string };
const emptyLineItem: LineItem = { description: "", quantity: "1", unitPrice: "0", taxRate: "0", taxLabel: "Tax" };

type ExistingClient = { id: string; name: string; email: string | null; phone: string | null; default_currency: string | null };
type Product = { id: string; name: string; description: string | null; default_price_cents: number; default_tax_rate_percent: number; default_tax_label: string };

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

export default function NewEstimateScreen() {
  const router = useRouter();
  const [existingClients, setExistingClients] = useState<ExistingClient[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [estimateNumber, setEstimateNumber] = useState(`EST-${Date.now().toString().slice(-6)}`);
  const [currency, setCurrency] = useState("USD");
  const [validUntil, setValidUntil] = useState("");
  const [depositRequested, setDepositRequested] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [terms, setTerms] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [lineItems, setLineItems] = useState<LineItem[]>([{ ...emptyLineItem }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase
      .from("clients")
      .select("id, name, email, phone, default_currency")
      .order("name")
      .then(({ data }) => setExistingClients(data ?? []));
    supabase
      .from("products")
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label")
      .order("name")
      .then(({ data }) => setProducts(data ?? []));
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

  const clientMatches =
    !clientId && clientName.trim().length > 0
      ? existingClients.filter((c) => c.name.toLowerCase().includes(clientName.trim().toLowerCase()))
      : [];

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

  async function handleSubmit() {
    setError(null);

    if (!clientId && !clientEmail.trim() && !clientPhone.trim()) {
      setError("client needs an email or phone");
      return;
    }

    setSubmitting(true);
    try {
      let finalClientId = clientId;

      if (!finalClientId) {
        // getSession() reads local storage — no network round trip, unlike getUser(). See the
        // matching comment in invoices/new.tsx for why this matters on a real device's network.
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("not signed in");
        const user = session.user;

        const trimmedName = clientName.trim().toLowerCase();
        const trimmedEmail = clientEmail.trim().toLowerCase();
        const duplicate = existingClients.find(
          (c) => c.name.trim().toLowerCase() === trimmedName || (trimmedEmail && c.email?.toLowerCase() === trimmedEmail),
        );

        if (duplicate) {
          finalClientId = duplicate.id;
        } else {
          const { data: client, error: clientError } = await supabase
            .from("clients")
            .insert({ user_id: user.id, name: clientName.trim(), email: clientEmail.trim() || null, phone: clientPhone.trim() || null })
            .select("id")
            .single();
          if (clientError) throw clientError;
          finalClientId = client.id;
        }
      }

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

      router.replace(`/estimates/${estimateId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create estimate");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} testID="new-estimate-screen">
      <Text style={styles.label}>Client</Text>
      {clientId ? (
        <View style={styles.selectedClient}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ flex: 1, flexShrink: 1 }} testID="selected-client">
              {existingClients.find((c) => c.id === clientId)?.name} (saved client)
            </Text>
            <Pressable onPress={() => setClientId("")}>
              <Text style={styles.link}>Change</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Search or type a new client name"
            value={clientName}
            onChangeText={setClientName}
            testID="client-name-input"
            autoCapitalize="words"
          />
          {clientMatches.length > 0 && (
            <FlatList
              testID="client-suggestions"
              data={clientMatches}
              keyExtractor={(c) => c.id}
              style={styles.suggestions}
              renderItem={({ item }) => (
                <Pressable
                  testID="client-suggestion"
                  style={styles.suggestionRow}
                  onPress={() => {
                    setClientId(item.id);
                    setClientName("");
                    if (item.default_currency) setCurrency(item.default_currency);
                  }}
                >
                  <Text>
                    {item.name}
                    {item.email ? ` · ${item.email}` : item.phone ? ` · ${item.phone}` : ""}
                  </Text>
                </Pressable>
              )}
            />
          )}
          <Text style={styles.label}>Client email</Text>
          <TextInput style={styles.input} value={clientEmail} onChangeText={setClientEmail} autoCapitalize="none" testID="client-email-input" />
          <Text style={styles.label}>Client phone</Text>
          <TextInput style={styles.input} value={clientPhone} onChangeText={setClientPhone} keyboardType="phone-pad" testID="client-phone-input" />
        </>
      )}

      <Text style={styles.label}>Estimate number</Text>
      <TextInput style={styles.input} value={estimateNumber} onChangeText={setEstimateNumber} />

      <Text style={styles.label}>Currency</Text>
      <View style={styles.currencyRow}>
        {CURRENCIES.map((c) => (
          <Pressable key={c} onPress={() => setCurrency(c)} style={[styles.currencyChip, currency === c && styles.currencyChipSelected]} testID={`currency-option-${c}`}>
            <Text style={[styles.currencyChipText, currency === c && styles.currencyChipTextSelected]}>{c}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Valid until (optional)</Text>
      <TextInput style={styles.input} value={validUntil} onChangeText={setValidUntil} placeholder="YYYY-MM-DD" testID="valid-until-input" />

      <Text style={styles.label}>Request deposit (optional)</Text>
      <TextInput style={styles.input} value={depositRequested} onChangeText={setDepositRequested} keyboardType="numeric" testID="deposit-input" />

      <Text style={styles.label}>Title (optional)</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Estimate" testID="estimate-title-input" />

      <Text style={styles.label}>Summary (optional)</Text>
      <TextInput style={styles.input} value={summary} onChangeText={setSummary} multiline testID="estimate-summary-input" />

      <View style={styles.lineItemsHeader}>
        <Text style={styles.label}>
          Line items <Text style={styles.lineItemCount} testID="line-item-count">{lineItems.length}</Text>
        </Text>
      </View>

      {products.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {products.map((p) => (
              <Pressable key={p.id} onPress={() => addFromCatalog(p)} style={styles.catalogChip} testID="catalog-product-chip">
                <Text style={styles.catalogChipText}>+ {p.name}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}

      {lineItems.map((item, i) => (
        <View key={i} style={styles.lineItemCard} testID="line-item-row">
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
            testID="line-item-description"
          />
          <View style={styles.lineItemFieldsRow}>
            <View style={styles.lineItemFieldQty}>
              <Text style={styles.fieldLabel}>Qty</Text>
              <TextInput style={styles.input} value={item.quantity} onChangeText={(v) => updateLineItem(i, "quantity", v)} keyboardType="numeric" />
            </View>
            <View style={styles.lineItemFieldRate}>
              <Text style={styles.fieldLabel}>Rate</Text>
              <TextInput style={styles.input} value={item.unitPrice} onChangeText={(v) => updateLineItem(i, "unitPrice", v)} keyboardType="numeric" testID="line-item-price" />
            </View>
            <View style={styles.lineItemFieldAmount}>
              <Text style={styles.fieldLabel}>Amount</Text>
              <Text style={styles.lineItemAmountValue} testID="line-item-amount">{lineAmount(item)}</Text>
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
            <TextInput
              style={styles.taxLabelInput}
              placeholder="HST, GST, VAT…"
              value={taxLabel}
              onChangeText={setTaxLabel}
              testID="estimate-tax-label"
            />
            <View style={styles.taxRateGroup}>
              <TextInput
                style={styles.taxRateInput}
                value={taxRate}
                onChangeText={setTaxRate}
                keyboardType="numeric"
                testID="estimate-tax-rate"
              />
              <Text style={styles.summaryLabel}>%</Text>
            </View>
          </View>
          <Text style={styles.summaryValue}>{tax.toFixed(2)}</Text>
        </View>
        <View style={[styles.summaryRow, styles.summaryTotalRow]}>
          <Text style={styles.summaryTotalLabel}>Total</Text>
          <Text style={styles.summaryTotalValue} testID="line-items-total">{(subtotal + tax).toFixed(2)}</Text>
        </View>
      </View>

      <Text style={styles.label}>Terms / notes</Text>
      <TextInput style={styles.input} value={terms} onChangeText={setTerms} multiline />

      {error && <Text style={styles.error} testID="new-estimate-error">{error}</Text>}

      <Pressable style={styles.button} onPress={handleSubmit} disabled={submitting} testID="submit-estimate-button">
        <Text style={styles.buttonText}>{submitting ? "Creating…" : "Create estimate"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  label: { fontSize: 13, color: "#71717a", marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 11, backgroundColor: colors.surface, fontSize: 15, color: colors.textPrimary },
  selectedClient: { borderWidth: 1, borderColor: "#5eead4", backgroundColor: "#f0fdfa", borderRadius: 8, padding: 10 },
  suggestions: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 8, marginTop: 4, maxHeight: 150 },
  suggestionRow: { padding: 10, borderBottomWidth: 1, borderBottomColor: "#f4f4f5" },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
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
