import { useCallback, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

type BillRow = {
  id: string;
  bill_number: string;
  status: string;
  total_cents: number;
  currency: string;
  vendor_name: string;
  due_date: string | null;
  reminder_days_before: number;
};

const STATUS_STYLES: Record<string, { bg: string; fg: string }> = {
  unpaid: { bg: "#fef3c7", fg: "#92400e" },
  paid: { bg: "#d1fae5", fg: "#065f46" },
};

export default function BillsScreen() {
  const router = useRouter();
  const [bills, setBills] = useState<BillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"approve" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reminderDays, setReminderDays] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("bills")
      .select("id, bill_number, status, total_cents, currency, vendor_name, due_date, reminder_days_before")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!cancelled) {
          const rows = (data as BillRow[]) ?? [];
          setBills(rows);
          setReminderDays((prev) => {
            const next = { ...prev };
            for (const r of rows) if (!(r.id in next)) next[r.id] = String(r.reminder_days_before);
            return next;
          });
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(load);

  async function dismiss(billId: string) {
    setBusyId(billId);
    setBusyAction("dismiss");
    setActionError(null);
    const { error } = await supabase.rpc("dismiss_detected_bill", { p_bill_id: billId });
    setBusyId(null);
    setBusyAction(null);
    if (error) {
      setActionError(error.message);
      return;
    }
    load();
  }

  async function approve(billId: string) {
    setBusyId(billId);
    setBusyAction("approve");
    setActionError(null);
    // Accepting a detected bill and confirming when to be reminded about it happen in one step .
    // save whatever reminder-days value is currently in the field before flipping it to unpaid.
    const days = Number(reminderDays[billId]);
    if (!Number.isNaN(days)) {
      const { error: updateError } = await supabase.from("bills").update({ reminder_days_before: days }).eq("id", billId);
      if (updateError) {
        setBusyId(null);
        setBusyAction(null);
        setActionError(updateError.message);
        return;
      }
    }
    const { error } = await supabase.rpc("approve_detected_bill", { p_bill_id: billId });
    setBusyId(null);
    setBusyAction(null);
    if (error) {
      setActionError(error.message);
      return;
    }
    load();
  }

  // pending_review/dismissed are excluded from both the visible list and the unpaid total by
  // filtering on the literal statuses. see the migration comment on why review state reuses
  // bill_status instead of a parallel column: an unconfirmed, AI-guessed bill must never count
  // toward "what you owe."
  const pendingReview = bills.filter((b) => b.status === "pending_review");
  const visibleBills = bills.filter((b) => b.status !== "pending_review" && b.status !== "dismissed");
  const unpaid = bills.filter((b) => b.status === "unpaid");
  const unpaidTotal = unpaid.reduce((sum, b) => sum + b.total_cents, 0);

  const header = (
    <View style={{ marginBottom: 16 }}>
      <Pressable style={styles.newButton} onPress={() => router.push("/bills/new")} testID="create-bill-button">
        <Text style={styles.newButtonText}>+ New bill</Text>
      </Pressable>
      {unpaid.length > 0 && (
        <View style={styles.unpaidBox} testID="unpaid-summary">
          <Text style={styles.unpaidText}>
            {(unpaidTotal / 100).toFixed(2)} unpaid across {unpaid.length} bill{unpaid.length === 1 ? "" : "s"}
          </Text>
        </View>
      )}
      {pendingReview.length > 0 && (
        <View style={styles.pendingBox} testID="pending-review-section">
          {actionError && <Text style={styles.pendingError}>{actionError}</Text>}
          <Text style={styles.pendingHeading}>
            {pendingReview.length} bill{pendingReview.length === 1 ? "" : "s"} detected from email
          </Text>
          {pendingReview.map((b) => (
            <View key={b.id} style={styles.pendingCard} testID="pending-review-row">
              <Text style={styles.rowName} numberOfLines={1}>{b.vendor_name}</Text>
              <Text style={styles.rowNumber}>
                {(b.total_cents / 100).toFixed(2)} {b.currency}
                {b.due_date ? ` · due ${b.due_date}` : ""}
              </Text>
              <View style={styles.pendingReminderRow}>
                <Text style={styles.pendingReminderLabel}>Remind me</Text>
                <TextInput
                  style={styles.pendingReminderInput}
                  value={reminderDays[b.id] ?? ""}
                  onChangeText={(v) => setReminderDays((prev) => ({ ...prev, [b.id]: v }))}
                  keyboardType="number-pad"
                  testID="pending-review-reminder-days"
                />
                <Text style={styles.pendingReminderLabel}>days before</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <Pressable
                  testID="dismiss-detected-bill"
                  disabled={busyId === b.id}
                  onPress={() => dismiss(b.id)}
                  style={styles.dismissButton}
                >
                  <Text style={styles.dismissButtonText}>
                    {busyId === b.id && busyAction === "dismiss" ? "Dismissing…" : "Dismiss"}
                  </Text>
                </Pressable>
                <Pressable
                  testID="approve-detected-bill"
                  disabled={busyId === b.id}
                  onPress={() => approve(b.id)}
                  style={styles.approveButton}
                >
                  <Text style={styles.approveButtonText}>
                    {busyId === b.id && busyAction === "approve" ? "Approving…" : "Approve"}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container} testID="bills-screen">
      {loading ? (
        <>
          {header}
          <Text style={styles.empty}>Loading…</Text>
        </>
      ) : visibleBills.length === 0 ? (
        <>
          {header}
          <Text style={styles.empty} testID="no-bills">
            No bills yet. A bill is money you owe a vendor, the mirror of an invoice.
          </Text>
        </>
      ) : (
        <FlatList
          testID="bill-list"
          data={visibleBills}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          renderItem={({ item }) => {
            const statusStyle = STATUS_STYLES[item.status] ?? STATUS_STYLES.unpaid;
            return (
              <Pressable style={styles.row} testID="bill-row" onPress={() => router.push(`/bills/${item.id}`)}>
                <View style={styles.rowLeft}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.vendor_name}</Text>
                  <Text style={styles.rowNumber}>{item.bill_number}</Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.statusBadge, { backgroundColor: statusStyle.bg, color: statusStyle.fg }]}>
                    {item.status}
                  </Text>
                  <Text style={styles.rowAmount}>
                    {(item.total_cents / 100).toFixed(2)} {item.currency}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  newButton: { backgroundColor: "#0f766e", borderRadius: 8, padding: 12, alignItems: "center" },
  newButtonText: { color: "#fff", fontWeight: "600" },
  unpaidBox: { backgroundColor: "#fffbeb", borderWidth: 1, borderColor: "#fde68a", borderRadius: 8, padding: 10, marginTop: 12 },
  unpaidText: { fontSize: 13, color: "#92400e", fontWeight: "600" },
  pendingBox: { backgroundColor: "#f0f9ff", borderWidth: 1, borderColor: "#bae6fd", borderRadius: 8, padding: 10, marginTop: 12, gap: 8 },
  pendingHeading: { fontSize: 13, color: "#075985", fontWeight: "600" },
  pendingError: { fontSize: 12, color: "#dc2626", fontWeight: "600" },
  pendingCard: { backgroundColor: "#fff", borderRadius: 8, padding: 10 },
  pendingReminderRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  pendingReminderLabel: { fontSize: 11, color: "#71717a" },
  pendingReminderInput: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4, fontSize: 12, width: 40, textAlign: "center" },
  dismissButton: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  dismissButtonText: { fontSize: 11, color: "#3f3f46", fontWeight: "600" },
  approveButton: { backgroundColor: "#0f766e", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  approveButtonText: { fontSize: 11, color: "#fff", fontWeight: "600" },
  empty: { color: "#71717a" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#e4e4e7",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  rowLeft: { flex: 1, flexShrink: 1 },
  rowName: { fontWeight: "600" },
  rowNumber: { fontSize: 11, color: "#71717a", marginTop: 2 },
  rowRight: { alignItems: "flex-end", gap: 4, flexShrink: 0 },
  statusBadge: { fontSize: 11, fontWeight: "600", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  rowAmount: { fontWeight: "600" },
});
