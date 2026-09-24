/**
 * Turning the reminder controls in a review row into the columns `bills` actually stores.
 *
 * The web counterpart is apps/web/lib/reminder-draft.ts and is kept in step with this file. Neither
 * lives in `packages/core` yet because neither app depends on that package at all today (it is
 * still the Phase-1 skeleton and Metro/Expo workspace resolution isn't wired up). The one real
 * difference is the exact-mode field: web holds a "YYYY-MM-DDTHH:mm" string because that is what
 * <input type="datetime-local"> speaks, while the native picker hands back a Date.
 */

export type ReminderDraft = {
  mode: "offset" | "exact";
  /** Kept as a string, not a number: a numeric TextInput mid-edit can legitimately be "" and
   * coercing on every keystroke makes the field impossible to clear. */
  value: string;
  unit: string;
  exactAt: Date | null;
};

export const REMINDER_UNITS = [
  { value: "minutes", label: "Min" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

/** Matches bills_reminder_offset_value_in_range in the migration — a value over the ceiling is a
 * constraint violation, and catching it here turns a raw Postgres error into a clamped value. */
const MAX_BY_UNIT: Record<string, number> = { minutes: 86400, hours: 1440, days: 60 };

/**
 * What the "Specific date" picker should open on: the instant already saved on the bill, else
 * 09:00 on the due date (a working-hours reminder on the day itself), else an hour from now.
 */
export function defaultExactAt(reminderAt: string | null, dueDate: string | null): Date {
  if (reminderAt) return new Date(reminderAt);
  if (dueDate) {
    // Parsed as local time deliberately (the T09:00 form, not the bare date, which JS would read as
    // UTC midnight) so the picker opens on 9am where the user actually is.
    const d = new Date(`${dueDate}T09:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() + 60 * 60 * 1000);
}

/**
 * The `bills` update payload for a draft, or null if the draft can't be saved as-is (exact mode
 * with nothing picked). Returning null rather than silently falling back to an offset matters:
 * quietly saving a different reminder than the one on screen is the kind of thing this product
 * exists to not do.
 */
export function reminderUpdatePayload(draft: ReminderDraft) {
  if (draft.mode === "exact") {
    if (!draft.exactAt || Number.isNaN(draft.exactAt.getTime())) return null;
    // reminder_offset_* are left untouched, so switching back to "Before due date" later restores
    // whatever offset the bill already had instead of resetting it to a default.
    return { reminder_mode: "exact", reminder_at: draft.exactAt.toISOString() };
  }

  const unit = MAX_BY_UNIT[draft.unit] ? draft.unit : "days";
  const parsed = Number(draft.value);
  const value = Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), 0), MAX_BY_UNIT[unit]) : 0;
  return { reminder_mode: "offset", reminder_offset_value: value, reminder_offset_unit: unit, reminder_at: null };
}

/** Compact, unambiguous rendering for the picker's trigger button — "24 Oct, 09:00". */
export function formatExactAt(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "Pick a date & time";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
