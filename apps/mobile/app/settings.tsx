import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../lib/supabase";

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

export default function SettingsScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [taxRegistrationNumber, setTaxRegistrationNumber] = useState("");
  const [defaultCurrency, setDefaultCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectionEnabled, setDetectionEnabled] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const id = data.session?.user.id ?? null;
      setUserId(id);
      if (!id) return;
      supabase
        .from("profiles")
        .select("business_name, business_address, tax_registration_number, default_currency")
        .eq("user_id", id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setBusinessName(data.business_name ?? "");
            setBusinessAddress(data.business_address ?? "");
            setTaxRegistrationNumber(data.tax_registration_number ?? "");
            setDefaultCurrency(data.default_currency ?? "USD");
          }
        });
      supabase
        .from("email_forwarding_addresses")
        .select("enabled")
        .eq("user_id", id)
        .maybeSingle()
        .then(({ data }) => setDetectionEnabled(data?.enabled ?? false));
    });
  }, []);

  async function handleSave() {
    if (!userId) return;
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
    <ScrollView style={styles.container} testID="settings-screen">
      <Text style={styles.title}>Business info</Text>
      <Text style={styles.subtitle}>Shown as the &quot;from&quot; details on every invoice you create.</Text>

      <Pressable onPress={() => router.push("/settings/products")} testID="products-link">
        <Text style={styles.link}>Manage products and services →</Text>
      </Pressable>

      <Text style={styles.label}>Business name</Text>
      <TextInput
        style={styles.input}
        value={businessName}
        onChangeText={setBusinessName}
        testID="business-name-input"
      />

      <Text style={styles.label}>Business address</Text>
      <TextInput
        style={styles.input}
        value={businessAddress}
        onChangeText={setBusinessAddress}
        multiline
        numberOfLines={3}
        testID="business-address-input"
      />

      <Text style={styles.label}>Tax registration number (optional)</Text>
      <TextInput
        style={styles.input}
        value={taxRegistrationNumber}
        onChangeText={setTaxRegistrationNumber}
        placeholder="e.g. GST/HST #, VAT number, EIN"
        testID="tax-registration-input"
      />

      <Text style={styles.label}>Default currency</Text>
      <View style={styles.currencyRow} testID="default-currency-picker">
        {CURRENCIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => setDefaultCurrency(c)}
            style={[styles.currencyChip, defaultCurrency === c && styles.currencyChipSelected]}
            testID={`default-currency-${c}`}
          >
            <Text style={[styles.currencyChipText, defaultCurrency === c && styles.currencyChipTextSelected]}>{c}</Text>
          </Pressable>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.button} onPress={handleSave} disabled={saving} testID="save-profile-button">
        <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
      </Pressable>
      {saved && (
        <Text style={styles.saved} testID="profile-saved">
          ✓ Saved
        </Text>
      )}

      <Pressable style={styles.detectionSummary} onPress={() => router.push("/connect-email")} testID="bill-detection-link">
        <View style={{ flex: 1 }}>
          <Text style={styles.detectionTitle}>Automatic bill detection</Text>
          <Text style={styles.detectionSubtitle}>{detectionEnabled ? "Connected, forwarding is active." : "Not connected yet."}</Text>
        </View>
        <Text style={styles.detectionAction}>{detectionEnabled ? "Manage" : "Set up"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { fontSize: 20, fontWeight: "600" },
  subtitle: { fontSize: 13, color: "#71717a", marginTop: 4, marginBottom: 16 },
  label: { fontSize: 13, color: "#71717a", marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, padding: 10 },
  link: { color: "#0f766e", textDecorationLine: "underline", fontSize: 13, marginBottom: 12 },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  currencyChip: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  currencyChipSelected: { backgroundColor: "#0f766e", borderColor: "#0f766e" },
  currencyChipText: { fontSize: 13, color: "#3f3f46", fontWeight: "600" },
  currencyChipTextSelected: { color: "#fff" },
  error: { color: "#dc2626", marginTop: 12 },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20, alignSelf: "flex-start", paddingHorizontal: 24 },
  buttonText: { color: "#fff", fontWeight: "600" },
  saved: { color: "#0f766e", marginTop: 12, fontWeight: "600" },
  detectionSummary: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e4e4e7",
    borderRadius: 12,
    padding: 14,
    marginTop: 24,
    marginBottom: 40,
  },
  detectionTitle: { fontSize: 14, fontWeight: "700" },
  detectionSubtitle: { fontSize: 12, color: "#71717a", marginTop: 2 },
  detectionAction: { color: "#0f766e", fontWeight: "700", fontSize: 13 },
});
