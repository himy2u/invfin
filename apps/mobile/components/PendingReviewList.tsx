import { useState, type ReactNode } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius } from "../lib/theme";
import { REMINDER_UNITS, type ReminderDraft, defaultExactAt, formatExactAt, reminderUpdatePayload } from "../lib/reminder-draft";

export type PendingBill = {
  id: string;
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
  // Android's picker is a one-shot modal and needs two passes (date, then time); iOS renders inline
  // and edits both at once. Tracking which bill + which stage is open covers both.
  const [picker, setPicker] = useState<{ billId: string; stage: "date" | "time" } | null>(null);

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

  function updateDraft(b: PendingBill, patch: Partial<ReminderDraft>) {
    setDrafts((prev) => ({ ...prev, [b.id]: { ...draftFor(b), ...patch } }));
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
    // save whatever reminder timing is currently in the row before flipping it to unpaid.
    const bill = bills.find((b) => b.id === billId);
    const payload = bill ? reminderUpdatePayload(draftFor(bill)) : null;
    if (!payload) {
      setBusyId(null);
      setBusyAction(null);
      setError("Pick a date and time for the reminder, or switch back to “Before due date”.");
      return;
    }
    const { error: updateError } = await supabase.from("bills").update(payload).eq("id", billId);
    if (updateError) {
      setBusyId(null);
      setBusyAction(null);
      setError(updateError.message);
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
    const draft = draftFor(b);
    return (
      <View style={styles.reminderBlock} testID="pending-review-reminder">
        <Text style={styles.reminderLabel}>Remind me</Text>
        <View style={styles.segmented}>
          {(
            [
              ["offset", "Before due"],
              ["exact", "Specific date"],
            ] as const
          ).map(([mode, label]) => (
            <Pressable
              key={mode}
              testID={`reminder-mode-${mode}`}
              onPress={() => updateDraft(b, { mode })}
              style={[styles.segment, draft.mode === mode && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, draft.mode === mode && styles.segmentTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {draft.mode === "exact" ? (
          <View style={styles.reminderRow}>
            <Pressable
              testID="pending-review-reminder-at"
              onPress={() => setPicker({ billId: b.id, stage: "date" })}
              style={styles.pickerButton}
            >
              <Text style={styles.pickerButtonText}>{formatExactAt(draft.exactAt)}</Text>
            </Pressable>
            {picker?.billId === b.id && (
              <DateTimePicker
                value={draft.exactAt ?? new Date()}
                mode={Platform.OS === "ios" ? "datetime" : picker.stage}
                onChange={(event: DateTimePickerEvent, selected?: Date) => {
                  if (event.type === "dismissed" || !selected) {
                    setPicker(null);
                    return;
                  }
                  updateDraft(b, { exactAt: selected });
                  // iOS edits date and time together, so one pass is the whole edit. Android has to
                  // hand off to the time picker, otherwise the minute the user typed is discarded.
                  setPicker(Platform.OS === "android" && picker.stage === "date" ? { billId: b.id, stage: "time" } : null);
                }}
              />
            )}
          </View>
        ) : (
          <View style={styles.reminderRow}>
            <TextInput
              style={styles.reminderInput}
              value={draft.value}
              onChangeText={(v) => updateDraft(b, { value: v })}
              keyboardType="number-pad"
              testID="pending-review-reminder-value"
            />
            <View style={styles.segmented}>
              {REMINDER_UNITS.map((u) => (
                <Pressable
                  key={u.value}
                  testID={`reminder-unit-${u.value}`}
                  onPress={() => updateDraft(b, { unit: u.value })}
                  style={[styles.segment, draft.unit === u.value && styles.segmentActive]}
                >
                  <Text style={[styles.segmentText, draft.unit === u.value && styles.segmentTextActive]}>{u.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.reminderLabel}>before</Text>
          </View>
        )}
      </View>
    );
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
            <Text style={styles.amount}>
              {(b.total_cents / 100).toFixed(2)} {b.currency}
            </Text>
          </View>
          <View style={styles.actionRow}>
            {reminderControls(b)}
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
  reminderBlock: { gap: 6 },
  reminderRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  reminderLabel: { fontSize: 11, color: colors.textSecondary },
  reminderInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4, fontSize: 12, width: 48, textAlign: "center" },
  segmented: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" },
  segment: { paddingHorizontal: 8, paddingVertical: 5, backgroundColor: colors.surface },
  segmentActive: { backgroundColor: colors.brand },
  segmentText: { fontSize: 11, color: colors.textSecondary, fontWeight: "600" },
  segmentTextActive: { color: colors.textOnBrand },
  pickerButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  pickerButtonText: { fontSize: 12, color: colors.textPrimary, fontWeight: "600" },
  buttonRow: { flexDirection: "row", gap: spacing.sm, justifyContent: "flex-end" },
  dismissButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  dismissButtonText: { fontSize: 11, color: colors.textSecondary, fontWeight: "600" },
  approveButton: { backgroundColor: colors.brand, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  approveButtonText: { fontSize: 11, color: colors.textOnBrand, fontWeight: "600" },
});
