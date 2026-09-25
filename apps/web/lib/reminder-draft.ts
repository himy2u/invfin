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
 * How far ahead an exact-mode reminder may be set. A <input type="datetime-local"> happily accepts a
 * six-digit year typed straight into the year field. A real tester got `100120` in and it was taken
 * without complaint until submit, which then reported "no date/time picked" (it had been; it was
 * just absurd). Two years covers every legitimate case for a bill reminder and makes a typo'd year
 * impossible to save.
 */
export const MAX_REMINDER_YEARS_AHEAD = 2;

/** Widest value <input type="datetime-local"> should accept, for its own `max` attribute. Keeps the
 * browser's native picker in step with the check in reminderUpdatePayload instead of letting the two
 * disagree about what's allowed. */
export function maxExactLocalValue(now: Date = new Date()): string {
  const at = new Date(now);
  at.setFullYear(at.getFullYear() + MAX_REMINDER_YEARS_AHEAD);
  return toLocalInputValue(at);
}

export function minExactLocalValue(now: Date = new Date()): string {
  return toLocalInputValue(now);
}

/** The exact column shapes the two modes write. Spelled out rather than a Record<string, unknown> so
 * Supabase's generated update() types can actually check the payload against the `bills` row type. */
export type ReminderUpdate =
  | { reminder_mode: "exact"; reminder_at: string }
  | { reminder_mode: "offset"; reminder_offset_value: number; reminder_offset_unit: string; reminder_at: null };

export type ReminderPayloadResult = { ok: true; payload: ReminderUpdate } | { ok: false; error: string };

/**
 * The `bills` update payload for a draft, or a specific reason it can't be saved as-is.
 *
 * Returns the reason rather than a bare null because the caller's only option with a null was one
 * generic message, and it said "pick a date and time" even when one HAD been picked and was simply
 * out of any sane range. An error message that misdescribes the problem sends the user looking in
 * the wrong place, which is its own small version of the lying-about-what-happened failure this
 * product exists to fix.
 */
export function reminderUpdatePayload(draft: ReminderDraft, now: Date = new Date()): ReminderPayloadResult {
  if (draft.mode === "exact") {
    if (!draft.exactLocal) {
      return { ok: false, error: "Pick a date and time for the reminder, or switch back to “Before due date”." };
    }
    // The year is checked from the raw string BEFORE Date parsing, because that is the case that
    // actually happened: <input type="datetime-local"> lets a year be typed to any width and emits
    // e.g. "100120-10-05T14:00", which `new Date()` rejects outright as unparseable (ISO needs a
    // "+100120" extended year). Left to the generic unparseable branch below, the user is told the
    // date "isn't real" when the real problem is that they fat-fingered the year field, which is
    // both fixable and worth naming.
    const year = Number(draft.exactLocal.split("-")[0]);
    const maxYear = now.getFullYear() + MAX_REMINDER_YEARS_AHEAD;
    if (Number.isFinite(year) && year > maxYear) {
      return {
        ok: false,
        error: `${year} is more than ${MAX_REMINDER_YEARS_AHEAD} years away. Check the year field: reminders can be set up to ${maxYear}.`,
      };
    }
    const at = new Date(draft.exactLocal);
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: "That date and time isn’t a real one. Pick it from the calendar instead of typing it." };
    }
    if (at.getTime() <= now.getTime()) {
      return {
        ok: false,
        error: `That time has already passed (${at.toLocaleString()}). Pick a reminder in the future.`,
      };
    }
    const latest = new Date(now);
    latest.setFullYear(latest.getFullYear() + MAX_REMINDER_YEARS_AHEAD);
    if (at.getTime() > latest.getTime()) {
      return {
        ok: false,
        error: `${at.getFullYear()} is more than ${MAX_REMINDER_YEARS_AHEAD} years away. Pick a reminder on or before ${latest.toLocaleDateString()}.`,
      };
    }
    // reminder_offset_* are left untouched, so switching back to "Before due date" later restores
    // whatever offset the bill already had instead of resetting it to a default.
    return { ok: true, payload: { reminder_mode: "exact", reminder_at: at.toISOString() } };
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
    const label = REMINDER_UNITS.find((u) => u.value === unit)?.label.toLowerCase() ?? unit;
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
 * One line describing a bill's saved reminder, e.g. "2 hours before due" / "Oct 5, 2026, 2:00 PM".
 *
 * Reads the stored columns, not a draft: this is what a bill's detail page shows about a reminder
 * that was already approved, which before now was invisible everywhere once the review row
 * disappeared, leaving the user no way to see, let alone check, what they had agreed to.
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
    return new Date(bill.reminder_at).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  if (!bill.due_date) {
    // An offset with nothing to offset FROM can never fire (compute_remind_at returns None). Saying
    // "2 days before due" here would describe a reminder that will not arrive.
    return "Needs a due date before it can fire";
  }
  const value = bill.reminder_offset_value;
  const unitLabel = (REMINDER_UNITS.find((u) => u.value === bill.reminder_offset_unit)?.label ?? bill.reminder_offset_unit)
    .toLowerCase();
  if (value === 0) return "On the due date";
  const singular = value === 1 ? unitLabel.replace(/s$/, "") : unitLabel;
  return `${value} ${singular} before due`;
}
