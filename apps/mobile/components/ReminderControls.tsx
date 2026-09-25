import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { colors } from "../lib/theme";
import { REMINDER_UNITS, type ReminderDraft, exactAtBounds, formatExactAt } from "../lib/reminder-draft";

/**
 * The offset/exact reminder control, in exactly one place on this platform.
 *
 * Lifted out of PendingReviewList so the bill DETAIL screen can edit an already-approved bill's
 * reminder with the same control the review row uses, rather than growing a second one that drifts
 * away from it. Mirrors apps/web/app/bills/reminder-fields.tsx.
 *
 * Owns no draft state (the caller does, because the review list keys one draft per row while the detail
 * screen has exactly one) but DOES own whether the native picker is currently open, which is purely
 * presentational and has no business leaking upward.
 */
export function ReminderControls({
  draft,
  onChange,
}: {
  draft: ReminderDraft;
  onChange: (patch: Partial<ReminderDraft>) => void;
}) {
  // Android's picker is a one-shot modal and needs two passes (date, then time); iOS renders inline
  // and edits both at once. Tracking which stage is open covers both.
  const [stage, setStage] = useState<"date" | "time" | null>(null);

  return (
    <View style={styles.block} testID="pending-review-reminder">
      <Text style={styles.label}>Remind me</Text>
      <View style={styles.segmented}>
        {(
          [
            ["offset", "Before due"],
            ["exact", "Specific date"],
          ] as const
        ).map(([mode, modeLabel]) => (
          <Pressable
            key={mode}
            testID={`reminder-mode-${mode}`}
            onPress={() => onChange({ mode })}
            style={[styles.segment, draft.mode === mode && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, draft.mode === mode && styles.segmentTextActive]}>{modeLabel}</Text>
          </Pressable>
        ))}
      </View>

      {draft.mode === "exact" ? (
        <View style={styles.row}>
          <Pressable testID="pending-review-reminder-at" onPress={() => setStage("date")} style={styles.pickerButton}>
            <Text style={styles.pickerButtonText}>{formatExactAt(draft.exactAt)}</Text>
          </Pressable>
          {stage && (
            <DateTimePicker
              value={draft.exactAt ?? new Date()}
              // The platform picker enforces the same bounds reminderUpdatePayload checks, so an
              // out-of-range instant can't be entered in the first place.
              minimumDate={exactAtBounds().min}
              maximumDate={exactAtBounds().max}
              mode={Platform.OS === "ios" ? "datetime" : stage}
              onChange={(event: DateTimePickerEvent, selected?: Date) => {
                if (event.type === "dismissed" || !selected) {
                  setStage(null);
                  return;
                }
                onChange({ exactAt: selected });
                // iOS edits date and time together, so one pass is the whole edit. Android has to
                // hand off to the time picker, otherwise the minute the user picked is discarded.
                setStage(Platform.OS === "android" && stage === "date" ? "time" : null);
              }}
            />
          )}
        </View>
      ) : (
        <View style={styles.row}>
          <TextInput
            style={styles.valueInput}
            value={draft.value}
            onChangeText={(v) => onChange({ value: v })}
            keyboardType="number-pad"
            testID="pending-review-reminder-value"
          />
          <View style={styles.segmented}>
            {REMINDER_UNITS.map((u) => (
              <Pressable
                key={u.value}
                testID={`reminder-unit-${u.value}`}
                onPress={() => onChange({ unit: u.value })}
                style={[styles.segment, draft.unit === u.value && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, draft.unit === u.value && styles.segmentTextActive]}>{u.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>before</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 6 },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  label: { fontSize: 11, color: colors.textSecondary },
  valueInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    fontSize: 12,
    width: 48,
    textAlign: "center",
  },
  segmented: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" },
  segment: { paddingHorizontal: 8, paddingVertical: 5, backgroundColor: colors.surface },
  segmentActive: { backgroundColor: colors.brand },
  segmentText: { fontSize: 11, color: colors.textSecondary, fontWeight: "600" },
  segmentTextActive: { color: colors.textOnBrand },
  pickerButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  pickerButtonText: { fontSize: 12, color: colors.textPrimary, fontWeight: "600" },
});
