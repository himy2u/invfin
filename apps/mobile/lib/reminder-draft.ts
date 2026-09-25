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
 * How far ahead an exact-mode reminder may be set, the same ceiling as web (see
 * MAX_REMINDER_YEARS_AHEAD there). The native picker makes an absurd year far harder to enter than
 * the web <input type="datetime-local"> did, but the bound is enforced on both so that a value
 * PATCHed straight at PostgREST from either client hits the same rule.
 */
export const MAX_REMINDER_YEARS_AHEAD = 2;

/** Bounds handed to DateTimePicker's own minimumDate/maximumDate, so the platform picker refuses
 * out-of-range instants instead of the app rejecting them only after the fact. */
export function exactAtBounds(now: Date = new Date()): { min: Date; max: Date } {
  const max = new Date(now);
  max.setFullYear(max.getFullYear() + MAX_REMINDER_YEARS_AHEAD);
  return { min: now, max };
}

/** The exact column shapes the two modes write. Spelled out rather than a Record<string, unknown> so
 * Supabase's generated update() types can actually check the payload against the `bills` row type. */
export type ReminderUpdate =
  | { reminder_mode: "exact"; reminder_at: string }
  | { reminder_mode: "offset"; reminder_offset_value: number; reminder_offset_unit: string; reminder_at: null };

export type ReminderPayloadResult = { ok: true; payload: ReminderUpdate } | { ok: false; error: string };

/**
 * The `bills` update payload for a draft, or a specific reason it can't be saved as-is. Mirrors
 * apps/web/lib/reminder-draft.ts. See the note there on why this reports the actual problem rather
 * than returning a bare null the caller can only describe with one generic (and often wrong)
 * message.
 */
export function reminderUpdatePayload(draft: ReminderDraft, now: Date = new Date()): ReminderPayloadResult {
  if (draft.mode === "exact") {
    if (!draft.exactAt || Number.isNaN(draft.exactAt.getTime())) {
      return { ok: false, error: "Pick a date and time for the reminder, or switch back to “Before due”." };
    }
    if (draft.exactAt.getTime() <= now.getTime()) {
      return {
        ok: false,
        error: `That time has already passed (${formatExactAt(draft.exactAt)}). Pick a reminder in the future.`,
      };
    }
    const latest = new Date(now);
    latest.setFullYear(latest.getFullYear() + MAX_REMINDER_YEARS_AHEAD);
    if (draft.exactAt.getTime() > latest.getTime()) {
      return {
        ok: false,
        error: `${draft.exactAt.getFullYear()} is more than ${MAX_REMINDER_YEARS_AHEAD} years away. Pick a reminder on or before ${latest.toLocaleDateString()}.`,
      };
    }
    // reminder_offset_* are left untouched, so switching back to "Before due date" later restores
    // whatever offset the bill already had instead of resetting it to a default.
    return { ok: true, payload: { reminder_mode: "exact", reminder_at: draft.exactAt.toISOString() } };
  }

  const unit = MAX_BY_UNIT[draft.unit] ? draft.unit : "days";
  const parsed = Number(draft.value);
  if (draft.value.trim() === "" || !Number.isFinite(parsed)) {
    return { ok: false, error: "Enter how long before the due date you want the reminder." };
  }
  if (parsed < 0) {
    return { ok: false, error: "A reminder can’t be a negative amount of time before the due date." };
  }
  if (Math.round(parsed) > MAX_BY_UNIT[unit]) {
    const label = (REMINDER_UNITS.find((u) => u.value === unit)?.label ?? unit).toLowerCase();
    return { ok: false, error: `${MAX_BY_UNIT[unit]} ${label} is the furthest ahead a reminder can be set.` };
  }
  return {
    ok: true,
    payload: {
      reminder_mode: "offset",
      reminder_offset_value: Math.round(parsed),
      reminder_offset_unit: unit,
      reminder_at: null,
    },
  };
}

/**
 * One line describing a bill's SAVED reminder, the mobile counterpart of describeReminder in
 * apps/web/lib/reminder-draft.ts. Reads the stored columns, not a draft, because this is what a
 * bill's detail screen shows about a reminder that was already approved.
 */
export function describeReminder(bill: {
  reminder_mode: string;
  reminder_offset_value: number;
  reminder_offset_unit: string;
  reminder_at: string | null;
  due_date: string | null;
}): string {
  if (bill.reminder_mode === "exact") {
    if (!bill.reminder_at) return "Not set";
    return new Date(bill.reminder_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  if (!bill.due_date) {
    // An offset with nothing to offset FROM can never fire (compute_remind_at returns None).
    return "Needs a due date before it can fire";
  }
  if (bill.reminder_offset_value === 0) return "On the due date";
  // REMINDER_UNITS uses the narrow "Min" label to fit the segmented control; a sentence needs the
  // real word.
  const spelled: Record<string, string> = { minutes: "minutes", hours: "hours", days: "days" };
  const unitLabel = spelled[bill.reminder_offset_unit] ?? bill.reminder_offset_unit;
  const singular = bill.reminder_offset_value === 1 ? unitLabel.replace(/s$/, "") : unitLabel;
  return `${bill.reminder_offset_value} ${singular} before due`;
}

/** Compact, unambiguous rendering for the picker's trigger button — "24 Oct, 09:00". */
export function formatExactAt(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "Pick a date & time";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
