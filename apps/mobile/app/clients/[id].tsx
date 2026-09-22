import { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { supabase } from "../../lib/supabase";

type Contact = { name: string; email: string; phone: string };
const emptyContact: Contact = { name: "", email: "", phone: "" };
const CURRENCIES = ["", "USD", "CAD", "EUR", "GBP", "AUD", "INR"];

type ClientDetail = {
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

export default function ClientDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [billingAddress, setBillingAddress] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [website, setWebsite] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const [defaultCurrency, setDefaultCurrency] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      supabase
        .from("clients")
        .select(
          "id, name, email, phone, billing_address, account_number, website, private_notes, additional_contacts, default_currency",
        )
        .eq("id", id)
        .single()
        .then(({ data }) => {
          if (cancelled || !data) return;
          const c = data as unknown as ClientDetail;
          setClient(c);
          setName(c.name);
          setEmail(c.email ?? "");
          setPhone(c.phone ?? "");
          setBillingAddress(c.billing_address ?? "");
          setAccountNumber(c.account_number ?? "");
          setWebsite(c.website ?? "");
          setPrivateNotes(c.private_notes ?? "");
          setDefaultCurrency(c.default_currency ?? "");
          setContacts(c.additional_contacts ?? []);
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [id]),
  );

  function updateContact(i: number, field: keyof Contact, value: string) {
    setContacts((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }

  async function handleSave() {
    if (!client) return;
    setSaving(true);
    setSaved(false);
    await supabase
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
    setSaved(true);
  }

  if (loading || !client) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Client" }} />
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} testID="client-detail-screen">
      <Stack.Screen options={{ title: client.name }} />

      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} testID="client-edit-name" />

      <Text style={styles.label}>Email</Text>
      <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" />

      <Text style={styles.label}>Phone</Text>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

      <Text style={styles.label}>Billing address</Text>
      <TextInput style={styles.input} value={billingAddress} onChangeText={setBillingAddress} multiline />

      <Text style={styles.label}>Account number (private)</Text>
      <TextInput style={styles.input} value={accountNumber} onChangeText={setAccountNumber} testID="client-account-number" />

      <Text style={styles.label}>Website</Text>
      <TextInput style={styles.input} value={website} onChangeText={setWebsite} autoCapitalize="none" testID="client-website" />

      <Text style={styles.label}>Currency</Text>
      <View style={styles.currencyRow}>
        {CURRENCIES.map((c) => (
          <Pressable
            key={c || "default"}
            onPress={() => setDefaultCurrency(c)}
            style={[styles.currencyChip, defaultCurrency === c && styles.currencyChipSelected]}
            testID={`client-currency-${c || "default"}`}
          >
            <Text style={[styles.currencyChipText, defaultCurrency === c && styles.currencyChipTextSelected]}>
              {c || "Default"}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Private notes</Text>
      <TextInput
        style={styles.input}
        value={privateNotes}
        onChangeText={setPrivateNotes}
        multiline
        placeholder="Only you can see this"
        testID="client-private-notes"
      />

      <View style={styles.contactsHeader}>
        <Text style={styles.label}>Additional contacts</Text>
        <Pressable onPress={() => setContacts((prev) => [...prev, { ...emptyContact }])} testID="add-contact-button">
          <Text style={styles.link}>+ Add contact</Text>
        </Pressable>
      </View>
      {contacts.map((c, i) => (
        <View key={i} style={styles.contactBlock} testID="additional-contact-row">
          <TextInput
            style={styles.input}
            placeholder="Name"
            value={c.name}
            onChangeText={(v) => updateContact(i, "name", v)}
          />
          <TextInput
            style={styles.input}
            placeholder="Email"
            value={c.email}
            onChangeText={(v) => updateContact(i, "email", v)}
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            placeholder="Phone"
            value={c.phone}
            onChangeText={(v) => updateContact(i, "phone", v)}
            keyboardType="phone-pad"
          />
        </View>
      ))}

      <Pressable style={styles.button} onPress={handleSave} disabled={saving} testID="save-client-button">
        <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
      </Pressable>
      {saved && (
        <Text style={styles.saved} testID="client-saved">
          ✓ Saved
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  label: { fontSize: 13, color: "#71717a", marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, padding: 10 },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  currencyChip: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  currencyChipSelected: { backgroundColor: "#0f766e", borderColor: "#0f766e" },
  currencyChipText: { fontSize: 13, color: "#3f3f46", fontWeight: "600" },
  currencyChipTextSelected: { color: "#fff" },
  contactsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  contactBlock: { gap: 6, marginBottom: 10, borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 8, padding: 10 },
  link: { color: "#0f766e", textDecorationLine: "underline", fontSize: 13 },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24, marginBottom: 40 },
  buttonText: { color: "#fff", fontWeight: "600" },
  saved: { color: "#0f766e", marginTop: -28, marginBottom: 40, textAlign: "center" },
});
