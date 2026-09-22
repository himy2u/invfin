import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "../../lib/supabase";

type Product = {
  id: string;
  name: string;
  description: string | null;
  default_price_cents: number;
  default_tax_rate_percent: number;
  default_tax_label: string;
  sku: string | null;
};

export default function ProductsScreen() {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [sku, setSku] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("products")
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label, sku")
      .order("name")
      .then(({ data }) => setProducts(data ?? []));
  }, []);

  async function handleAdd() {
    if (!name.trim()) return;
    setError(null);

    if (products.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      setError(`"${name.trim()}" is already in your catalog.`);
      return;
    }

    setSaving(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setError("not signed in");
      setSaving(false);
      return;
    }
    const user = session.user;

    const { data, error: insertError } = await supabase
      .from("products")
      .insert({
        user_id: user.id,
        name: name.trim(),
        description: description.trim() || null,
        default_price_cents: Math.round(Number(price) * 100) || 0,
        default_tax_label: taxLabel.trim() || "Tax",
        default_tax_rate_percent: Number(taxRate) || 0,
        sku: sku.trim() || null,
      })
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label, sku")
      .single();

    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setProducts((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    setName("");
    setDescription("");
    setPrice("");
    setTaxLabel("Tax");
    setTaxRate("0");
    setSku("");
  }

  async function handleDelete(id: string) {
    await supabase.from("products").delete().eq("id", id);
    setProducts((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <ScrollView style={styles.container} testID="products-screen">
      <Text style={styles.subtitle}>
        Save a price, description, and tax once, then pick it from the catalog when building an invoice.
      </Text>

      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} testID="product-name-input" />

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput style={styles.input} value={description} onChangeText={setDescription} testID="product-description-input" />

      <View style={styles.row}>
        <View style={styles.flex1}>
          <Text style={styles.label}>Default price</Text>
          <TextInput style={styles.input} value={price} onChangeText={setPrice} keyboardType="numeric" testID="product-price-input" />
        </View>
        <View style={styles.flex1}>
          <Text style={styles.label}>Tax name</Text>
          <TextInput style={styles.input} value={taxLabel} onChangeText={setTaxLabel} />
        </View>
        <View style={styles.flex1}>
          <Text style={styles.label}>Tax %</Text>
          <TextInput style={styles.input} value={taxRate} onChangeText={setTaxRate} keyboardType="numeric" />
        </View>
      </View>

      <Text style={styles.label}>SKU (optional)</Text>
      <TextInput style={styles.input} value={sku} onChangeText={setSku} testID="product-sku-input" />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.button} onPress={handleAdd} disabled={saving} testID="add-product-button">
        <Text style={styles.buttonText}>{saving ? "Adding…" : "Add product"}</Text>
      </Pressable>

      <View style={{ marginTop: 24 }}>
        {products.length === 0 && (
          <Text style={styles.empty} testID="no-products">
            No products yet.
          </Text>
        )}
        {products.map((p) => (
          <View key={p.id} style={styles.productRow} testID="product-row">
            <View style={{ flex: 1 }}>
              <Text style={styles.productName}>{p.name}</Text>
              {p.description && <Text style={styles.productSub}>{p.description}</Text>}
              <Text style={styles.productSub}>
                {(p.default_price_cents / 100).toFixed(2)}
                {p.default_tax_rate_percent > 0 ? ` + ${p.default_tax_label} ${p.default_tax_rate_percent}%` : ""}
                {p.sku ? ` · SKU ${p.sku}` : ""}
              </Text>
            </View>
            <Pressable onPress={() => handleDelete(p.id)} testID="delete-product-button">
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  subtitle: { fontSize: 13, color: "#71717a", marginBottom: 16 },
  label: { fontSize: 13, color: "#71717a", marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, padding: 10 },
  row: { flexDirection: "row", gap: 8 },
  flex1: { flex: 1 },
  error: { color: "#dc2626", marginTop: 12 },
  button: { backgroundColor: "#0f766e", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 16, alignSelf: "flex-start", paddingHorizontal: 24 },
  buttonText: { color: "#fff", fontWeight: "600" },
  empty: { color: "#71717a" },
  productRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 8, padding: 12, marginBottom: 8, gap: 8 },
  productName: { fontWeight: "600", fontSize: 14 },
  productSub: { fontSize: 12, color: "#71717a", marginTop: 2 },
  deleteText: { color: "#dc2626", fontSize: 13 },
});
