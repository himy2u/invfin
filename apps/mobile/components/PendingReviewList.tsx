import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius } from "../lib/theme";
import { formatMoney } from "../lib/money";
import { type ReminderDraft, defaultExactAt, reminderUpdatePayload } from "../lib/reminder-draft";
import { ReminderControls } from "./ReminderControls";

export type PendingBill = {
  id: string;
  bill_number?: string | null;
  duplicate_of_bill_id?: string | null;
  duplicate_of_bill_number?: string | null;
  vendor_name: string;
  total_cents: number;
  currency: string;
  due_date: string | null;
  reminder_mode: string;
  reminder_offset_value: number;
  reminder_offset_unit: string;
  reminder_at: string | null;
};

/**
 * Approve-or-edit-the-reminder for email-detected bills — the mobile counterpart of
 * apps/web/app/bills/pending-review-section.tsx, down to the same approve_detected_bill /
 * dismiss_detected_bill RPCs and the same one-action approve (the reminder timing in the row is
 * saved as part of approving, never as a separate confirm step).
 *
 * Shared by /bills and /connect-email so that logic exists once on this platform too. Mobile has
 * no HTML table, so the "table" variant is the card list permanently in its stacked form.
 *
 * The date+time control is @react-native-community/datetimepicker — the platform's own picker
 * behind a thin bridge, not a JS calendar UI. Picked over a third-party calendar component because
 * it is the one Expo itself ships a config plugin for, it adds no visual design of its own to keep
 * in step with the web version, and this app already requires a dev build (expo-notifications,
 * expo-local-authentication), so a native module costs nothing extra here.
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
  const [drafts, setDrafts] = useState<Record<string, ReminderDraft>>({});
  // Reminder edits are written as they're made, not held until Approve. See the equivalent comment in
  // apps/web/app/bills/pending-review-section.tsx: an edit that only exists in component state is one
  // re-mount away from being silently lost, and losing a value the user just chose is not acceptable
  // on either platform.
  const [saveState, setSaveState] = useState<Record<string, "saving" | "saved">>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timers = saveTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  function draftFor(b: PendingBill): ReminderDraft {
    return (
      drafts[b.id] ?? {
        mode: b.reminder_mode === "exact" ? "exact" : "offset",
        value: String(b.reminder_offset_value),
        unit: b.reminder_offset_unit,
        exactAt: defaultExactAt(b.reminder_at, b.due_date),
      }
    );
  }

  async function persist(billId: string, draft: ReminderDraft): Promise<boolean> {
    const result = reminderUpdatePayload(draft);
    const clearSaveState = () =>
      setSaveState((prev) => {
        const next = { ...prev };
        delete next[billId];
        return next;
      });
    if (!result.ok) {
      setError(result.error);
      clearSaveState();
      return false;
    }
    setError(null);
    const { error: updateError } = await supabase.from("bills").update(result.payload).eq("id", billId);
    if (updateError) {
      setError(updateError.message);
      clearSaveState();
      return false;
    }
    setSaveState((prev) => ({ ...prev, [billId]: "saved" }));
    return true;
  }

  function updateDraft(b: PendingBill, patch: Partial<ReminderDraft>) {
    const next = { ...draftFor(b), ...patch };
    setDrafts((prev) => ({ ...prev, [b.id]: next }));
    setSaveState((prev) => ({ ...prev, [b.id]: "saving" }));
    clearTimeout(saveTimers.current[b.id]);
    saveTimers.current[b.id] = setTimeout(() => {
      void persist(b.id, next);
    }, 600);
  }

  async function dismiss(billId: string) {
    setBusyId(billId);
    setBusyAction("dismiss");
    setError(null);
    clearTimeout(saveTimers.current[billId]);
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
    // save whatever reminder timing is currently in the row before flipping it to unpaid.
    const bill = bills.find((b) => b.id === billId);
    if (!bill) {
      setBusyId(null);
      setBusyAction(null);
      return;
    }
    // Flushes any autosave still sitting in its debounce, so the value on screen is the value saved.
    clearTimeout(saveTimers.current[billId]);
    const saved = await persist(billId, draftFor(bill));
    if (!saved) {
      setBusyId(null);
      setBusyAction(null);
      return;
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

  function reminderControls(b: PendingBill) {
    return <ReminderControls draft={draftFor(b)} onChange={(patch) => updateDraft(b, patch)} />;
  }

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
              {/* Due date sits directly under the vendor and at the vendor's own weight, not as
                  muted metadata — it is the field the reminder decision hangs on. */}
              <Text style={b.due_date ? styles.dueDate : styles.dueDateMissing} testID="pending-review-due-date">
                {b.due_date ? `Due ${b.due_date}` : "No due date"}
              </Text>
            </View>
            <Text style={styles.amount}>{formatMoney(b.total_cents, b.currency)}</Text>
          </View>
          {b.duplicate_of_bill_id && (
            <Text style={styles.duplicateFlag} testID="duplicate-bill-flag">
              ⚠ Possible duplicate of {b.duplicate_of_bill_number ?? "an existing bill"}: same vendor, amount and due
              date. Dismiss this one if it’s the same bill.
            </Text>
          )}
          <View style={styles.actionRow}>
            {reminderControls(b)}
            {saveState[b.id] && (
              <Text style={saveState[b.id] === "saved" ? styles.savedCue : styles.savingCue} testID="reminder-save-state">
                {saveState[b.id] === "saved" ? "Saved" : "Saving…"}
              </Text>
            )}
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
  dueDate: { fontSize: 13, fontWeight: "700", color: colors.textPrimary, marginTop: 2 },
  dueDateMissing: { fontSize: 13, fontWeight: "600", color: colors.textMuted, marginTop: 2 },
  amount: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  actionRow: { gap: spacing.sm, marginTop: spacing.sm },
  duplicateFlag: { fontSize: 11, color: "#b45309", fontWeight: "600", marginTop: 6 },
  savedCue: { fontSize: 11, color: colors.brand, fontWeight: "600" },
  savingCue: { fontSize: 11, color: colors.textMuted },
  buttonRow: { flexDirection: "row", gap: spacing.sm, justifyContent: "flex-end" },
  dismissButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  dismissButtonText: { fontSize: 11, color: colors.textSecondary, fontWeight: "600" },
  approveButton: { backgroundColor: colors.brand, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  approveButtonText: { fontSize: 11, color: colors.textOnBrand, fontWeight: "600" },
});
