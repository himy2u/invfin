import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, Image, StyleSheet, FlatList } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { supabase } from "../../lib/supabase";
import { ChatInvoiceBuilder, type InvoiceDraft } from "../../components/ChatInvoiceBuilder";
import { colors, spacing, radius, cardShadow } from "../../lib/theme";

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxLabel: string;
};
const emptyLineItem: LineItem = { description: "", quantity: "1", unitPrice: "0", taxRate: "0", taxLabel: "Tax" };

type ExistingClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  default_currency: string | null;
};
type PastInvoice = { id: string; invoice_number: string; clients: { name: string } | null };

type Product = {
  id: string;
  name: string;
  description: string | null;
  default_price_cents: number;
  default_tax_rate_percent: number;
  default_tax_label: string;
};

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "INR"];

type ScanResult = {
  document_type: "invoice" | "receipt" | "purchase_order" | "timesheet" | null;
  vendor: string | null;
  vendor_address?: string | null;
  client_name: string | null;
  client_address?: string | null;
  client_email?: string | null;
  client_phone?: string | null;
  invoice_number: string | null;
  reference_number: string | null;
  line_items: { description: string; quantity: number; unit_price: number }[];
  tax: number;
  total: number | null;
  total_matches_line_items: boolean;
  error?: string;
};

export default function NewInvoiceScreen() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const [existingClients, setExistingClients] = useState<ExistingClient[]>([]);
  const [pastInvoices, setPastInvoices] = useState<PastInvoice[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState(`INV-${Date.now().toString().slice(-6)}`);
  const [terms, setTerms] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [poNumber, setPoNumber] = useState("");
  // One invoice-level tax (name + rate) applied to every line — matches how real invoices are
  // almost always taxed and avoids a per-line tax name/rate pair repeated on every row.
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [taxRate, setTaxRate] = useState("0");
  const [businessName, setBusinessName] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [taxRegistrationNumber, setTaxRegistrationNumber] = useState("");
  const [businessProfileWasEmpty, setBusinessProfileWasEmpty] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([{ ...emptyLineItem }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);

  const [nlText, setNlText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [fillNotice, setFillNotice] = useState<string | null>(null);
  // Separate from fillNotice's text so a real "the numbers might be wrong" warning gets the app's
  // amber warning color instead of the same teal used for a routine "go check this field" nudge —
  // the two were visually identical, which is exactly the kind of silent-wrongness this product's
  // pitch says it will never do.
  const [fillIsWarning, setFillIsWarning] = useState(false);
  // Offered after a non-timesheet scan/parse — a timesheet's rows are logged hours, not reusable
  // catalog items, but an invoice/receipt/PO's line items usually ARE products or services worth
  // remembering for next time.
  const [canSaveToCatalog, setCanSaveToCatalog] = useState(false);
  const [catalogSaved, setCatalogSaved] = useState(false);

  useEffect(() => {
    supabase
      .from("clients")
      .select("id, name, email, phone, billing_address, default_currency")
      .order("name")
      .then(({ data }) => setExistingClients(data ?? []));
    supabase
      .from("invoices")
      .select("id, invoice_number, clients(name)")
      .order("created_at", { ascending: false })
      .limit(25)
      .then(({ data }) => setPastInvoices((data as PastInvoice[]) ?? []));
    supabase
      .from("products")
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label")
      .order("name")
      .then(({ data }) => setProducts(data ?? []));
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      supabase
        .from("profiles")
        .select("default_currency, business_name, business_address, tax_registration_number")
        .eq("user_id", session.user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.default_currency) setCurrency(data.default_currency);
          setBusinessName(data?.business_name ?? "");
          setBusinessAddress(data?.business_address ?? "");
          setTaxRegistrationNumber(data?.tax_registration_number ?? "");
          setBusinessProfileWasEmpty(!data?.business_name);
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

  async function handleSaveToCatalog() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    const existingNames = new Set(products.map((p) => p.name.trim().toLowerCase()));
    const toInsert = lineItems.filter(
      (item) => item.description.trim() && !existingNames.has(item.description.trim().toLowerCase()),
    );
    if (toInsert.length === 0) {
      setCatalogSaved(true);
      return;
    }

    const { data, error: insertError } = await supabase
      .from("products")
      .insert(
        toInsert.map((item) => ({
          user_id: session.user.id,
          name: item.description.trim(),
          default_price_cents: Math.round(Number(item.unitPrice) * 100) || 0,
          default_tax_label: taxLabel || "Tax",
          default_tax_rate_percent: Number(taxRate) || 0,
        })),
      )
      .select("id, name, description, default_price_cents, default_tax_rate_percent, default_tax_label");
    if (insertError) return;

    setProducts((prev) => [...prev, ...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
    setCatalogSaved(true);
  }

  function lineAmount(item: LineItem) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    return (qty * price).toFixed(2);
  }

  const lineItemsSubtotal = lineItems.reduce((sum, item) => sum + Number(lineAmount(item)), 0);
  const lineItemsTax = lineItemsSubtotal * ((Number(taxRate) || 0) / 100);

  async function handleUseTemplate(id: string) {
    if (!id) return;
    setLoadingTemplate(true);
    setError(null);
    try {
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .select("client_id, terms, currency, title, summary")
        .eq("id", id)
        .single();
      if (invoiceError || !invoice) throw new Error("couldn't load that invoice");

      const { data: items, error: itemsError } = await supabase
        .from("invoice_line_items")
        .select("description, quantity, unit_price_cents, tax_rate_percent, tax_label")
        .eq("invoice_id", id)
        .order("sort_order");
      if (itemsError) throw itemsError;

      setClientId(invoice.client_id);
      setTerms(invoice.terms ?? "");
      setCurrency(invoice.currency);
      setTitle(invoice.title ?? "");
      setSummary(invoice.summary ?? "");
      if (items && items.length > 0) {
        setTaxRate(String(items[0].tax_rate_percent));
        setTaxLabel(items[0].tax_label);
        setLineItems(
          items.map((item) => ({
            description: item.description,
            quantity: String(item.quantity),
            unitPrice: (item.unit_price_cents / 100).toString(),
            taxRate: "0",
            taxLabel: "Tax",
          })),
        );
      }
      setFillIsWarning(false);
      setFillNotice("Copied the client and line items. Adjust quantities, prices, or dates before creating.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't load that invoice as a template");
    } finally {
      setLoadingTemplate(false);
    }
  }

  function applyExtractedData(data: ScanResult, sourceLabel: string) {
    setClientId("");
    setClientName(data.client_name ?? "");
    if (data.client_address) setClientAddress(data.client_address);
    if (data.client_email) setClientEmail(data.client_email);
    if (data.client_phone) setClientPhone(data.client_phone);
    if (data.invoice_number) setInvoiceNumber(data.invoice_number);
    if (businessProfileWasEmpty) {
      if (data.vendor) setBusinessName(data.vendor);
      if (data.vendor_address) setBusinessAddress(data.vendor_address);
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
          taxRate: "0",
          taxLabel: "Tax",
        })),
      );
    }
    if (data.document_type === "purchase_order" && data.reference_number) {
      setPoNumber(data.reference_number);
    }
    const isMismatch = data.document_type !== "timesheet" && !data.total_matches_line_items;
    setFillIsWarning(isMismatch);
    setCanSaveToCatalog(data.document_type !== "timesheet" && data.line_items.length > 0);
    setCatalogSaved(false);
    setFillNotice(
      data.document_type === "timesheet"
        ? "Read hours from the timesheet. Fill in the rate per line and the client's email/phone before creating."
        : data.total_matches_line_items
          ? `Read from ${data.vendor ?? "the"} ${sourceLabel}. Check the client's email/phone below before creating.`
          : `Read from ${data.vendor ?? "the"} ${sourceLabel}, but the total didn't match the line items. Double-check the amounts before creating.`,
    );
  }

  function applyChatDraft(draft: InvoiceDraft) {
    setClientId("");
    setClientName(draft.client_name ?? "");
    if (draft.client_email) setClientEmail(draft.client_email);
    if (draft.client_phone) setClientPhone(draft.client_phone);
    if (draft.title) setTitle(draft.title);
    if (draft.summary) setSummary(draft.summary);
    if (draft.po_number) setPoNumber(draft.po_number);
    if (draft.due_date) setDueDate(draft.due_date);
    setTaxRate(String(draft.tax_rate_percent || 0));
    if (draft.line_items.length > 0) {
      setLineItems(
        draft.line_items.map((item) => ({
          description: item.description,
          quantity: String(item.quantity),
          unitPrice: String(item.unit_price),
          taxRate: "0",
          taxLabel: "Tax",
        })),
      );
    }
  }

  async function scanFile(file: { uri: string; name: string; type: string }) {
    setError(null);
    setFillNotice(null);
    setParsing(true);

    try {
      const formData = new FormData();
      formData.append("file", file as unknown as Blob);

      const agentUrl = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/scan-invoice`, { method: "POST", body: formData });
      const data: ScanResult = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");

      const sourceLabel =
        data.document_type === "purchase_order"
          ? "purchase order"
          : data.document_type === "timesheet"
            ? "timesheet"
            : file.type === "text/csv"
              ? "CSV"
              : "photo";
      applyExtractedData(data, sourceLabel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan failed");
    } finally {
      setParsing(false);
    }
  }

  async function takePhotoAndScan() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError("camera permission denied");
      return;
    }
    const picked = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (picked.canceled) return;

    const asset = picked.assets[0];
    setImageUri(asset.uri);
    await scanFile({ uri: asset.uri, name: "invoice.jpg", type: asset.mimeType ?? "image/jpeg" });
  }

  async function pickPhotoAndScan() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("photo library permission denied");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (picked.canceled) return;

    const asset = picked.assets[0];
    setImageUri(asset.uri);
    await scanFile({ uri: asset.uri, name: "invoice.jpg", type: asset.mimeType ?? "image/jpeg" });
  }

  async function pickCsvAndScan() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["text/csv", "text/comma-separated-values", "application/vnd.ms-excel"],
    });
    if (picked.canceled) return;

    const asset = picked.assets[0];
    setImageUri(null);
    await scanFile({ uri: asset.uri, name: asset.name || "timesheet.csv", type: "text/csv" });
  }

  async function handleParseText() {
    if (!nlText.trim()) return;
    setParsing(true);
    setFillNotice(null);
    setError(null);

    try {
      const agentUrl = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/parse-invoice-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: nlText }),
      });
      const data: ScanResult = await res.json();
      if (!res.ok) throw new Error(data.error ?? "parse failed");
      applyExtractedData(data, "request");
    } catch (err) {
      setError(err instanceof Error ? err.message : "parse failed");
    } finally {
      setParsing(false);
    }
  }

  async function handleSubmit() {
    setError(null);

    if (!clientId && !clientEmail.trim() && !clientPhone.trim()) {
      setError("client needs an email or phone, that's what delivery/open notifications go to");
      return;
    }

    setSubmitting(true);
    try {
      let finalClientId = clientId;

      // getSession() reads the already-verified session straight out of local storage — no
      // network round trip. getUser() re-validates against the auth server on every call, so on
      // a flaky connection (real device, weak signal) it can time out or fail transiently and
      // throw "not signed in" even though the user is genuinely signed in; this screen is only
      // reachable at all because the root layout already confirmed a session exists.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("not signed in");
      const user = session.user;

      if (!finalClientId) {
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
            .insert({
              user_id: user.id,
              name: clientName.trim(),
              email: clientEmail.trim() || null,
              phone: clientPhone.trim() || null,
              billing_address: clientAddress.trim() || null,
            })
            .select("id")
            .single();
          if (clientError) throw clientError;
          finalClientId = client.id;
        }
      }

      // "From" was showing "not set" for every new user's first invoice — save whatever business
      // info was entered/prefilled from a scan right alongside creating the invoice.
      if (businessProfileWasEmpty && businessName.trim()) {
        await supabase.from("profiles").upsert({
          user_id: user.id,
          business_name: businessName.trim(),
          business_address: businessAddress.trim() || null,
          tax_registration_number: taxRegistrationNumber.trim() || null,
        });
      }

      const { error: rpcError } = await supabase.rpc("create_invoice_with_line_items", {
        p_client_id: finalClientId,
        p_invoice_number: invoiceNumber,
        p_currency: currency,
        p_issue_date: new Date().toISOString().slice(0, 10),
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
          discount_cents: 0,
        })),
      });
      if (rpcError) throw rpcError;

      router.replace("/invoices");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create invoice");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} testID="new-invoice-screen">
      {pastInvoices.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <Text style={styles.label}>Use a past invoice as a template</Text>
          <View style={styles.templateList}>
            {pastInvoices.slice(0, 5).map((inv) => (
              <Pressable
                key={inv.id}
                style={styles.templateRow}
                onPress={() => handleUseTemplate(inv.id)}
                testID="template-option"
              >
                <Text style={{ fontSize: 13 }}>
                  {inv.invoice_number}: {inv.clients?.name ?? "Unknown client"}
                </Text>
              </Pressable>
            ))}
          </View>
          {loadingTemplate && <Text style={{ color: "#71717a", fontSize: 13 }}>Loading…</Text>}
        </View>
      )}

      <ChatInvoiceBuilder onUseDraft={applyChatDraft} autoOpen={mode === "chat"} />

      <View style={styles.fillBox}>
        <Text style={styles.fillLabel}>Describe it, or scan a document, either pre-fills below</Text>
        <TextInput
          style={styles.input}
          placeholder='"bill Acme Corp $500 for design work"'
          value={nlText}
          onChangeText={setNlText}
          editable={!parsing}
          testID="nl-text-input"
        />
        {nlText.trim().length > 0 && (
          <Pressable
            style={styles.parseButton}
            onPress={handleParseText}
            disabled={parsing}
            testID="nl-parse-button"
          >
            <Text style={styles.buttonText}>{parsing ? "Parsing…" : "Parse"}</Text>
          </Pressable>
        )}
        <View style={styles.scanButtonRow}>
          <Pressable style={styles.scanButton} onPress={takePhotoAndScan} disabled={parsing} testID="take-photo-button">
            <Text style={styles.scanButtonText}>📷 Take photo</Text>
          </Pressable>
          <Pressable style={styles.scanButton} onPress={pickPhotoAndScan} disabled={parsing} testID="pick-image-button">
            <Text style={styles.scanButtonText}>🖼 Choose photo</Text>
          </Pressable>
          <Pressable style={styles.scanButton} onPress={pickCsvAndScan} disabled={parsing} testID="pick-csv-button">
            <Text style={styles.scanButtonText}>📄 Upload CSV</Text>
          </Pressable>
        </View>
        {imageUri && <Image source={{ uri: imageUri }} style={styles.preview} />}
        {fillNotice && (
          <Text style={[styles.fillNotice, fillIsWarning && styles.fillWarning]} testID="fill-notice">
            {fillIsWarning ? "⚠ " : ""}
            {fillNotice}
          </Text>
        )}
        {canSaveToCatalog && !catalogSaved && (
          <Pressable onPress={handleSaveToCatalog} testID="save-to-catalog-button">
            <Text style={styles.link}>+ Save these items to your product catalog</Text>
          </Pressable>
        )}
        {catalogSaved && (
          <Text style={styles.catalogSavedText} testID="catalog-saved-notice">
            ✓ Saved to your catalog. Pick them from the chips next time.
          </Text>
        )}
      </View>

      {businessProfileWasEmpty ? (
        <View style={styles.businessBox}>
          <Text style={styles.businessBoxLabel}>Your business info (shown as &quot;From&quot; on the invoice)</Text>
          <TextInput
            style={styles.input}
            placeholder="Business name"
            value={businessName}
            onChangeText={setBusinessName}
            testID="business-name-input"
          />
          <TextInput
            style={styles.input}
            placeholder="Business address"
            value={businessAddress}
            onChangeText={setBusinessAddress}
            multiline
            testID="business-address-input"
          />
          <TextInput
            style={styles.input}
            placeholder="Tax registration number (optional)"
            value={taxRegistrationNumber}
            onChangeText={setTaxRegistrationNumber}
            testID="tax-registration-input"
          />
          <Text style={styles.businessBoxHint}>Saved to your business profile once you create this invoice.</Text>
        </View>
      ) : (
        <View style={styles.businessSummaryRow}>
          <Text style={styles.businessSummaryText}>From: {businessName}</Text>
          <Pressable onPress={() => router.push("/settings")}>
            <Text style={styles.link}>Edit</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.label}>Client</Text>
      {clientId ? (
        <View style={styles.selectedClient}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={[styles.selectedClientText, { flex: 1, flexShrink: 1 }]} testID="selected-client">
              {existingClients.find((c) => c.id === clientId)?.name} (saved client)
            </Text>
            <Pressable onPress={() => setClientId("")} testID="change-client-button">
              <Text style={styles.link}>Change</Text>
            </Pressable>
          </View>
          {existingClients.find((c) => c.id === clientId)?.billing_address && (
            <Text style={styles.addressText}>
              {existingClients.find((c) => c.id === clientId)?.billing_address}
            </Text>
          )}
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
                    setClientEmail("");
                    setClientPhone("");
                    setClientAddress("");
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
          <TextInput
            style={styles.input}
            value={clientEmail}
            onChangeText={setClientEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            testID="client-email-input"
          />
          <Text style={styles.label}>Client phone</Text>
          <TextInput
            style={styles.input}
            value={clientPhone}
            onChangeText={setClientPhone}
            keyboardType="phone-pad"
            testID="client-phone-input"
          />
          <Text style={styles.label}>Billing address (optional)</Text>
          <TextInput
            style={styles.input}
            value={clientAddress}
            onChangeText={setClientAddress}
            multiline
            numberOfLines={2}
            testID="client-address-input"
          />
        </>
      )}

      <Text style={styles.label}>Invoice number</Text>
      <TextInput style={styles.input} value={invoiceNumber} onChangeText={setInvoiceNumber} />

      <Text style={styles.label}>Due date (optional)</Text>
      <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" testID="due-date-input" />

      <Text style={styles.label}>Currency</Text>
      <View style={styles.currencyRow} testID="currency-picker">
        {CURRENCIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => setCurrency(c)}
            style={[styles.currencyChip, currency === c && styles.currencyChipSelected]}
            testID={`currency-option-${c}`}
          >
            <Text style={[styles.currencyChipText, currency === c && styles.currencyChipTextSelected]}>{c}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>P.O./S.O. number (optional)</Text>
      <TextInput style={styles.input} value={poNumber} onChangeText={setPoNumber} placeholder="PO-1024" testID="po-number-input" />

      <Text style={styles.label}>Invoice title (optional)</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Invoice" testID="invoice-title-input" />

      <Text style={styles.label}>Summary (optional)</Text>
      <TextInput
        style={styles.input}
        value={summary}
        onChangeText={setSummary}
        placeholder="A short note near the top of the invoice"
        multiline
        testID="invoice-summary-input"
      />

      <View style={styles.lineItemsHeader}>
        <Text style={styles.label}>
          Line items <Text style={styles.lineItemCount} testID="line-item-count">{lineItems.length}</Text>
        </Text>
      </View>

      {products.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {products.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => addFromCatalog(p)}
                style={styles.catalogChip}
                testID="catalog-product-chip"
              >
                <Text style={styles.catalogChipText}>+ {p.name}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}

      {/* Each line item is its own card, stacked vertically — not a 5-column table squeezed into
          a 380px-wide screen. A real horizontally-scrolling mini-spreadsheet is what made this
          screen read as a shrunk desktop form; a phone-native invoicing app (Wave, Square) always
          presents editable line items as cards, one field per row, not a cramped grid. */}
      {lineItems.map((item, i) => (
        <View key={i} style={styles.lineItemCard} testID="line-item-row">
          <View style={styles.lineItemCardHeader}>
            <Text style={styles.lineItemIndex}>Item {i + 1}</Text>
            <Pressable
              onPress={() => removeLineItem(i)}
              disabled={lineItems.length === 1}
              hitSlop={8}
              testID="remove-line-item"
            >
              <Text style={[styles.removeText, lineItems.length === 1 && styles.removeTextDisabled]}>Remove</Text>
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, styles.lineItemDescriptionInput]}
            placeholder="Description"
            value={item.description}
            onChangeText={(v) => updateLineItem(i, "description", v)}
            testID="line-item-description"
          />
          <View style={styles.lineItemFieldsRow}>
            <View style={styles.lineItemFieldQty}>
              <Text style={styles.fieldLabel}>Qty</Text>
              <TextInput
                style={styles.input}
                value={item.quantity}
                onChangeText={(v) => updateLineItem(i, "quantity", v)}
                keyboardType="numeric"
              />
            </View>
            <View style={styles.lineItemFieldRate}>
              <Text style={styles.fieldLabel}>Rate</Text>
              <TextInput
                style={styles.input}
                value={item.unitPrice}
                onChangeText={(v) => updateLineItem(i, "unitPrice", v)}
                keyboardType="numeric"
                testID="line-item-price"
              />
            </View>
            <View style={styles.lineItemFieldAmount}>
              <Text style={styles.fieldLabel}>Amount</Text>
              <Text style={styles.lineItemAmountValue} testID="line-item-amount">
                {lineAmount(item)}
              </Text>
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
          <Text style={styles.summaryValue}>{lineItemsSubtotal.toFixed(2)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <View style={styles.taxInputRow}>
            <TextInput
              style={styles.taxLabelInput}
              placeholder="HST, GST, VAT…"
              value={taxLabel}
              onChangeText={setTaxLabel}
              testID="invoice-tax-label"
            />
            <View style={styles.taxRateGroup}>
              <TextInput
                style={styles.taxRateInput}
                value={taxRate}
                onChangeText={setTaxRate}
                keyboardType="numeric"
                testID="invoice-tax-rate"
              />
              <Text style={styles.summaryLabel}>%</Text>
            </View>
          </View>
          <Text style={styles.summaryValue}>{lineItemsTax.toFixed(2)}</Text>
        </View>
        <View style={[styles.summaryRow, styles.summaryTotalRow]}>
          <Text style={styles.summaryTotalLabel}>Total</Text>
          <Text style={styles.summaryTotalValue} testID="line-items-total">
            {(lineItemsSubtotal + lineItemsTax).toFixed(2)}
          </Text>
        </View>
      </View>

      {error && (
        <Text style={styles.error} testID="new-invoice-error">
          {error}
        </Text>
      )}

      <Pressable style={styles.button} onPress={handleSubmit} disabled={submitting} testID="submit-invoice-button">
        <Text style={styles.buttonText}>{submitting ? "Creating…" : "Create invoice"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl, backgroundColor: colors.background },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.xs },
  currencyChip: { borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  currencyChipSelected: { backgroundColor: colors.brand, borderColor: colors.brand },
  currencyChipText: { fontSize: 13, color: colors.textSecondary, fontWeight: "600" },
  currencyChipTextSelected: { color: "#fff" },
  catalogChip: { borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandLight, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  catalogChipText: { fontSize: 12, color: colors.brand, fontWeight: "600" },
  templateList: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, ...cardShadow },
  templateRow: { padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.background },
  fillBox: { borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandLight, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.lg },
  fillLabel: { fontSize: 13, fontWeight: "700", color: colors.brandDark, marginBottom: spacing.sm },
  parseButton: { backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: spacing.sm, alignItems: "center", marginTop: spacing.sm, alignSelf: "flex-start", paddingHorizontal: spacing.xl },
  scanButtonRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  scanButton: { flexGrow: 1, flexBasis: "30%", backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: spacing.md, paddingHorizontal: spacing.sm, alignItems: "center" },
  scanButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  preview: { width: "100%", height: 120, borderRadius: radius.sm, marginTop: spacing.sm },
  fillNotice: { fontSize: 13, color: colors.brandDark, marginTop: spacing.sm },
  fillWarning: { color: colors.warning, fontWeight: "700" },
  catalogSavedText: { fontSize: 13, color: colors.brand, marginTop: spacing.sm },
  label: { fontSize: 13, color: colors.textSecondary, fontWeight: "600", marginTop: spacing.sm, marginBottom: spacing.xs },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 11, backgroundColor: colors.surface, fontSize: 15, color: colors.textPrimary },
  selectedClient: { borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandLight, borderRadius: radius.sm, padding: spacing.md },
  selectedClientText: { fontSize: 14 },
  addressText: { fontSize: 12, color: colors.brand, marginTop: spacing.xs },
  suggestions: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, marginTop: spacing.xs, maxHeight: 150, backgroundColor: colors.surface },
  suggestionRow: { padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.background },
  lineItemsHeader: { marginTop: spacing.lg },
  lineItemCount: { fontSize: 12, fontWeight: "700", color: colors.brand, backgroundColor: colors.brandLight, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: "hidden" },
  lineItemCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, gap: spacing.sm, ...cardShadow },
  lineItemCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  lineItemIndex: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4 },
  lineItemDescriptionInput: {},
  lineItemFieldsRow: { flexDirection: "row", gap: spacing.sm },
  lineItemFieldQty: { width: 64 },
  lineItemFieldRate: { flex: 1 },
  lineItemFieldAmount: { flex: 1, alignItems: "flex-end" },
  lineItemAmountValue: { paddingVertical: 11, fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  removeText: { fontSize: 12, color: colors.danger, fontWeight: "700" },
  removeTextDisabled: { color: colors.borderStrong },
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
  fieldLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 4, fontWeight: "600" },
  flex1: { flex: 1 },
  link: { color: colors.brand, fontWeight: "600", marginTop: spacing.sm },
  businessBox: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, gap: spacing.sm, marginBottom: spacing.sm, ...cardShadow },
  businessBoxLabel: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  businessBoxHint: { fontSize: 11, color: colors.textMuted },
  businessSummaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.sm },
  businessSummaryText: { fontSize: 13, color: colors.textPrimary, flex: 1, flexShrink: 1 },
  summaryBox: { marginTop: spacing.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.lg, gap: spacing.xs, ...cardShadow },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  // The tax name is an inline-editable label (underline only, no full box) so it visually reads
  // as "tap to rename this," distinct from the rate — a proper bordered field, since it's the
  // actual number being typed. Two adjacent full-bordered boxes is what made this row look like
  // two unrelated broken inputs jammed together.
  taxInputRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1 },
  taxLabelInput: {
    fontSize: 13,
    color: colors.textSecondary,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    minWidth: 70,
  },
  taxRateGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.surface,
  },
  taxRateInput: { fontSize: 13, color: colors.textPrimary, width: 28, textAlign: "right", padding: 0 },
  summaryLabel: { fontSize: 13, color: colors.textSecondary },
  summaryValue: { fontSize: 13, color: colors.textPrimary, fontWeight: "600" },
  summaryTotalRow: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, marginTop: 2 },
  summaryTotalLabel: { fontSize: 15, fontWeight: "800", color: colors.textPrimary },
  summaryTotalValue: { fontSize: 15, fontWeight: "800", color: colors.textPrimary },
  error: { color: colors.danger, marginTop: spacing.md, fontWeight: "500" },
  button: { backgroundColor: colors.brand, borderRadius: radius.sm, padding: spacing.md, alignItems: "center", marginTop: spacing.xl, marginBottom: spacing.xxl, ...cardShadow },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
