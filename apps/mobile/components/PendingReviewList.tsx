import { useState, type ReactNode } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius } from "../lib/theme";

export type PendingBill = {
  id: string;
  vendor_name: string;
  total_cents: number;
  currency: string;
  due_date: string | null;
  reminder_days_before: number;
};

/**
 * Approve-or-edit-the-reminder for email-detected bills — the mobile counterpart of
 * apps/web/app/bills/pending-review-section.tsx, down to the same approve_detected_bill /
 * dismiss_detected_bill RPCs and the same one-action approve (the reminder value in the field is
 * saved as part of approving, never as a separate confirm step).
 *
 * Shared by /bills and /connect-email so that logic exists once on this platform too. Mobile has
 * no HTML table, so the "table" variant is the card list permanently in its stacked form.
 */
export function PendingReviewList({
  bills,
  variant = "notice",
  heading,
  emptyState = null,
  onChanged,
}: {
  bills: PendingBill[];
  variant?: "notice" | "table";
  heading?: ReactNode;
  emptyState?: ReactNode;
  /** Called with the bill that just left the queue, so the caller can drop it immediately rather
   * than wait for its own next poll/refetch to notice. */
  onChanged: (billId: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"approve" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reminderDays, setReminderDays] = useState<Record<string, string>>({});

  function daysValue(b: PendingBill) {
    return reminderDays[b.id] ?? String(b.reminder_days_before);
  }

  async function dismiss(billId: string) {
    setBusyId(billId);
    setBusyAction("dismiss");
    setError(null);
    const { error } = await supabase.rpc("dismiss_detected_bill", { p_bill_id: billId });
    setBusyId(null);
    setBusyAction(null);
    if (error) {
      setError(error.message);
      return;
    }
    onChanged(billId);
  }

  async function approve(billId: string) {
    setBusyId(billId);
    setBusyAction("approve");
    setError(null);
    // Accepting a detected bill and confirming when to be reminded about it happen in one step:
    // save whatever reminder-days value is currently in the field before flipping it to unpaid.
    const bill = bills.find((b) => b.id === billId);
    const days = bill ? Number(daysValue(bill)) : NaN;
    if (!Number.isNaN(days)) {
      const { error: updateError } = await supabase.from("bills").update({ reminder_days_before: days }).eq("id", billId);
      if (updateError) {
        setBusyId(null);
        setBusyAction(null);
        setError(updateError.message);
        return;
      }
    }
    const { error } = await supabase.rpc("approve_detected_bill", { p_bill_id: billId });
    setBusyId(null);
    setBusyAction(null);
    if (error) {
      setError(error.message);
      return;
    }
    onChanged(billId);
  }

  if (bills.length === 0) return <>{emptyState}</>;

  const isTable = variant === "table";

  return (
    <View style={isTable ? styles.tableBox : styles.noticeBox} testID="pending-review-section">
      {error && <Text style={styles.error}>{error}</Text>}
      {heading ?? (
        <Text style={styles.noticeHeading}>
          {bills.length} bill{bills.length === 1 ? "" : "s"} detected from email
        </Text>
      )}
      {bills.map((b) => (
        <View key={b.id} style={isTable ? styles.tableCard : styles.noticeCard} testID="pending-review-row">
          <View style={styles.cardTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.vendor} numberOfLines={1}>
                {b.vendor_name}
              </Text>
              <Text style={styles.meta}>{b.due_date ? `Due ${b.due_date}` : "No due date"}</Text>
            </View>
            <Text style={styles.amount}>
              {(b.total_cents / 100).toFixed(2)} {b.currency}
            </Text>
          </View>
          <View style={styles.actionRow}>
            <View style={styles.reminderRow}>
              <Text style={styles.reminderLabel}>Remind me</Text>
              <TextInput
                style={styles.reminderInput}
                value={daysValue(b)}
                onChangeText={(v) => setReminderDays((prev) => ({ ...prev, [b.id]: v }))}
                keyboardType="number-pad"
                testID="pending-review-reminder-days"
              />
              <Text style={styles.reminderLabel}>days before</Text>
            </View>
            <View style={styles.buttonRow}>
              <Pressable testID="dismiss-detected-bill" disabled={busyId === b.id} onPress={() => dismiss(b.id)} style={styles.dismissButton}>
                <Text style={styles.dismissButtonText}>
                  {busyId === b.id && busyAction === "dismiss" ? "Dismissing…" : "Dismiss"}
                </Text>
              </Pressable>
              <Pressable testID="approve-detected-bill" disabled={busyId === b.id} onPress={() => approve(b.id)} style={styles.approveButton}>
                <Text style={styles.approveButtonText}>
                  {busyId === b.id && busyAction === "approve" ? "Approving…" : "Approve"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  noticeBox: { backgroundColor: "#f0f9ff", borderWidth: 1, borderColor: "#bae6fd", borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.md, gap: spacing.sm },
  noticeHeading: { fontSize: 13, color: "#075985", fontWeight: "600" },
  noticeCard: { backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.sm },
  tableBox: { gap: spacing.xs },
  tableCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, padding: spacing.sm },
  error: { fontSize: 12, color: colors.danger, fontWeight: "600" },
  cardTopRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  vendor: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  meta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  amount: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  actionRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, marginTop: spacing.sm },
  reminderRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  reminderLabel: { fontSize: 11, color: colors.textSecondary },
  reminderInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4, fontSize: 12, width: 40, textAlign: "center" },
  buttonRow: { flexDirection: "row", gap: spacing.sm },
  dismissButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  dismissButtonText: { fontSize: 11, color: colors.textSecondary, fontWeight: "600" },
  approveButton: { backgroundColor: colors.brand, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  approveButtonText: { fontSize: 11, color: colors.textOnBrand, fontWeight: "600" },
});
