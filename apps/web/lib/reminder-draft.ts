/**
 * Turning the reminder controls in a review row into the columns `bills` actually stores.
 *
 * Lives here rather than in `packages/core` for now because neither app currently depends on that
 * package at all (it is still the Phase-1 skeleton, and Metro/Expo workspace resolution isn't wired
 * up) — the mobile counterpart is apps/mobile/lib/reminder-draft.ts and is kept identical. The
 * moment a second piece of logic needs sharing, wire up @invfin/core and move both.
 */

export type ReminderDraft = {
  mode: "offset" | "exact";
  /** Kept as a string, not a number: an <input type="number"> mid-edit can legitimately be "" or
   * "0", and coercing on every keystroke makes the field impossible to clear. */
  value: string;
  unit: string;
  /** "YYYY-MM-DDTHH:mm" in the viewer's own local time, which is what <input type="datetime-local">
   * both emits and expects. Empty when nothing has been picked. */
  exactLocal: string;
};

export const REMINDER_UNITS = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

/** Matches bills_reminder_offset_value_in_range in the migration — a value over the ceiling is a
 * constraint violation, and catching it here turns a raw Postgres error into a clamped value. */
const MAX_BY_UNIT: Record<string, number> = { minutes: 86400, hours: 1440, days: 60 };

function toLocalInputValue(d: Date): string {
  // Not toISOString(): that converts to UTC, and a datetime-local input given a UTC string either
  // renders blank or silently shows the wrong clock time.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What the "Specific date" field should show before the user touches it: the instant already saved
 * on the bill, else 09:00 on the due date (a working-hours reminder on the day itself, the most
 * common thing anyone picking an exact time actually wants), else an hour from now.
 */
export function defaultExactLocalValue(reminderAt: string | null, dueDate: string | null): string {
  if (reminderAt) return toLocalInputValue(new Date(reminderAt));
  if (dueDate) return `${dueDate}T09:00`;
  return toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000));
}

/**
 * The `bills` update payload for a draft, or null if the draft can't be saved as-is (exact mode
 * with no instant picked). Returning null rather than silently falling back to an offset matters:
 * quietly saving a different reminder than the one on screen is the kind of thing this product
 * exists to not do.
 */
export function reminderUpdatePayload(draft: ReminderDraft) {
  if (draft.mode === "exact") {
    if (!draft.exactLocal) return null;
    const at = new Date(draft.exactLocal);
    if (Number.isNaN(at.getTime())) return null;
    // reminder_offset_* are left untouched, so switching back to "Before due date" later restores
    // whatever offset the bill already had instead of resetting it to a default.
    return { reminder_mode: "exact", reminder_at: at.toISOString() };
  }

  const unit = MAX_BY_UNIT[draft.unit] ? draft.unit : "days";
  const parsed = Number(draft.value);
  const value = Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), 0), MAX_BY_UNIT[unit]) : 0;
  return { reminder_mode: "offset", reminder_offset_value: value, reminder_offset_unit: unit, reminder_at: null };
}
