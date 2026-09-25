import { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { supabase } from "../../lib/supabase";
import { confirmAsync } from "../../lib/confirm";
import { formatAmount, formatMoney } from "../../lib/money";
import {
  type ReminderDraft,
  defaultExactAt,
  describeReminder,
  reminderUpdatePayload,
} from "../../lib/reminder-draft";
import { ReminderControls } from "../../components/ReminderControls";

type BillDetail = {
  id: string;
  bill_number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  vendor_name: string;
  vendor_address: string | null;
  vendor_email: string | null;
  vendor_phone: string | null;
  due_date: string | null;
  po_number: string | null;
  terms: string | null;
  reminder_mode: string;
  reminder_offset_value: number;
  reminder_offset_unit: string;
  reminder_at: string | null;
  reminder_sent_at: string | null;
  duplicate_of_bill_id: string | null;
};

type LineItem = { description: string; quantity: number; unit_price_cents: number };

export default function BillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The reminder a bill was approved with was invisible and uneditable on this screen until now: the
  // only place to configure it was the pending-review row, which disappears on approval. Mirrors
  // apps/web/app/bills/[id]/reminder-editor.tsx, down to reusing the same control.
  const [editingReminder, setEditingReminder] = useState(false);
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft | null>(null);
  const [savingReminder, setSavingReminder] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    supabase
      .from("bills")
      .select(
        "id, bill_number, status, currency, subtotal_cents, tax_cents, total_cents, vendor_name, vendor_address, vendor_email, vendor_phone, due_date, po_number, terms, reminder_mode, reminder_offset_value, reminder_offset_unit, reminder_at, reminder_sent_at, duplicate_of_bill_id",
      )
      .eq("id", id)
      .single()
      .then(({ data }) => {
        setBill(data as BillDetail | null);
        setLoading(false);
      });
    supabase
      .from("bill_line_items")
      .select("description, quantity, unit_price_cents")
      .eq("bill_id", id)
      .order("sort_order")
      .then(({ data }) => setLineItems(data ?? []));
  }, [id]);

  useFocusEffect(load);

  async function confirmMarkPaid() {
    const confirmed = await confirmAsync("Mark as paid?", "This records that you've already paid the vendor.");
    if (confirmed) handleMarkPaid();
  }

  async function handleMarkPaid() {
    if (!bill) return;
    setMarking(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("mark_bill_paid", { p_bill_id: bill.id });
      if (rpcError) throw rpcError;
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to mark as paid");
    } finally {
      setMarking(false);
    }
  }

  if (loading || !bill) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Bill" }} />
        <Text>Loading…</Text>
      </View>
    );
  }

  const fmt = (cents: number) => formatMoney(cents, bill.currency);
  const draft: ReminderDraft =
    reminderDraft ?? {
      mode: bill.reminder_mode === "exact" ? "exact" : "offset",
      value: String(bill.reminder_offset_value),
      unit: bill.reminder_offset_unit,
      exactAt: defaultExactAt(bill.reminder_at, bill.due_date),
    };

  async function saveReminder() {
    const result = reminderUpdatePayload(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavingReminder(true);
    setError(null);
    const { error: updateError } = await supabase.from("bills").update(result.payload).eq("id", bill!.id);
    setSavingReminder(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setEditingReminder(false);
    setReminderDraft(null);
    load();
  }

  return (
    <ScrollView style={styles.container} testID="bill-detail-screen">
      <Stack.Screen options={{ title: bill.bill_number }} />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{bill.vendor_name}</Text>
          {/* Due date is the second line, directly under the vendor, at the vendor's own size and
              weight — not folded into the muted metadata line below, where it used to read as an
              afterthought. Mirrors apps/web/app/bills/[id]/page.tsx. */}
          <Text style={bill.due_date ? styles.dueDate : styles.dueDateMissing} testID="bill-due-date">
            {bill.due_date ? `Due ${bill.due_date}` : "No due date"}
          </Text>
          <Text style={styles.subtitle}>
            {bill.bill_number}
            {bill.po_number ? ` · PO ${bill.po_number}` : ""} · {bill.currency}
          </Text>
          {bill.vendor_address && <Text style={styles.addressText}>{bill.vendor_address}</Text>}
          {(bill.vendor_email || bill.vendor_phone) && (
            <Text style={styles.addressText}>{bill.vendor_email || bill.vendor_phone}</Text>
          )}
        </View>
        <Text
          style={[
            styles.statusBadge,
            bill.status === "paid" ? styles.statusPaid : styles.statusUnpaid,
          ]}
          testID="bill-status"
        >
          {bill.status}
        </Text>
      </View>

      {bill.duplicate_of_bill_id && (
        <Text style={styles.duplicateFlag} testID="duplicate-bill-flag">
          ⚠ Possible duplicate: another bill has the same vendor, amount and due date. If it’s the same bill forwarded
          twice, mark one paid or delete it. We haven’t assumed either way.
        </Text>
      )}

      {/* Only for a bill that can still get a reminder. A paid bill's reminder is spent history, and
          offering to edit it would imply a notification is still coming. */}
      {bill.status !== "paid" && (
        <View style={styles.reminderBox} testID="bill-reminder">
          <View style={styles.reminderHeader}>
            <Text style={styles.reminderSummary} testID="bill-reminder-summary">
              Reminder: {describeReminder(bill)}
              {bill.reminder_sent_at ? ` · sent ${new Date(bill.reminder_sent_at).toLocaleString()}` : ""}
            </Text>
            <Pressable
              testID="edit-bill-reminder"
              onPress={() => {
                setError(null);
                setEditingReminder((v) => !v);
              }}
              style={styles.reminderEditButton}
            >
              <Text style={styles.reminderEditButtonText}>{editingReminder ? "Cancel" : "Edit"}</Text>
            </Pressable>
          </View>
          {editingReminder && (
            <View style={styles.reminderEditArea}>
              <ReminderControls draft={draft} onChange={(patch) => setReminderDraft({ ...draft, ...patch })} />
              <Pressable
                testID="save-bill-reminder"
                disabled={savingReminder}
                onPress={saveReminder}
                style={styles.reminderSaveButton}
              >
                <Text style={styles.reminderSaveButtonText}>{savingReminder ? "Saving…" : "Save reminder"}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {lineItems.map((item, i) => (
        <View key={i} style={styles.lineItemRow} testID="bill-line-item">
          <Text style={{ flex: 1 }}>{item.description}</Text>
          <Text style={styles.amount}>{formatAmount(item.quantity * item.unit_price_cents)}</Text>
        </View>
      ))}

      <View style={styles.totals}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Subtotal</Text>
          <Text>{fmt(bill.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Tax</Text>
          <Text>{fmt(bill.tax_cents)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabelBold}>Total</Text>
          <Text style={styles.totalLabelBold} testID="bill-total">
            {fmt(bill.total_cents)}
          </Text>
        </View>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {bill.status === "unpaid" && (
        <Pressable style={styles.button} onPress={confirmMarkPaid} disabled={marking} testID="mark-bill-paid-button">
          <Text style={styles.buttonText}>{marking ? "Marking…" : "Mark as paid"}</Text>
        </Pressable>
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
  addressText: { fontSize: 12, color: "#71717a", marginTop: 4 },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, fontWeight: "600" },
  statusUnpaid: { backgroundColor: "#fef3c7", color: "#92400e" },
  statusPaid: { backgroundColor: "#d1fae5", color: "#065f46" },
  duplicateFlag: { fontSize: 12, color: "#b45309", fontWeight: "600", marginBottom: 12 },
  reminderBox: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 8, padding: 10, marginBottom: 12, gap: 8 },
  reminderHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  reminderSummary: { flex: 1, fontSize: 12, color: "#3f3f46", fontWeight: "600" },
  reminderEditButton: { borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  reminderEditButtonText: { fontSize: 11, color: "#52525b", fontWeight: "600" },
  reminderEditArea: { gap: 10, borderTopWidth: 1, borderTopColor: "#f4f4f5", paddingTop: 10 },
  reminderSaveButton: { backgroundColor: "#0f766e", borderRadius: 6, paddingVertical: 8, alignItems: "center" },
  reminderSaveButtonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
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
