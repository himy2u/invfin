"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  type ReminderDraft,
  defaultExactLocalValue,
  describeReminder,
  reminderUpdatePayload,
} from "@/lib/reminder-draft";
import { ReminderFields } from "../reminder-fields";

type ReminderBill = {
  id: string;
  due_date: string | null;
  reminder_mode: string;
  reminder_offset_value: number;
  reminder_offset_unit: string;
  reminder_at: string | null;
  reminder_sent_at: string | null;
};

/**
 * What reminder is set on this bill, and a way to change it.
 *
 * The gap this fills: the ONLY place a reminder could be configured was the pending-review row, and
 * that row disappears the moment the bill is approved. From then on the reminder was invisible and
 * uneditable, so the user had agreed to something they could no longer see. Two independent testers
 * hit this and flagged it. The control itself is the same <ReminderFields> the review table uses, not
 * a second one built to match.
 *
 * A client component rather than part of the server-rendered page because describeReminder() formats
 * an exact-mode instant in the viewer's own timezone: rendering that on the server would print the
 * server's clock and then mismatch on hydration.
 */
export function ReminderEditor({ bill }: { bill: ReminderBill }) {
  const supabase = createClient();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReminderDraft>({
    mode: bill.reminder_mode === "exact" ? "exact" : "offset",
    value: String(bill.reminder_offset_value),
    unit: bill.reminder_offset_unit,
    exactLocal: defaultExactLocalValue(bill.reminder_at, bill.due_date),
  });

  async function save() {
    const result = reminderUpdatePayload(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    const { error: updateError } = await supabase.from("bills").update(result.payload).eq("id", bill.id);
    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 p-3" data-testid="bill-reminder">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-700">
          <span className="font-medium">Reminder: </span>
          <span data-testid="bill-reminder-summary">{describeReminder(bill)}</span>
          {/* Whether it already fired is part of the truth about this reminder, not a detail. A user
              looking at "2 hours before due" has no way to tell from that line alone whether the
              notification is still coming or already came and went. */}
          {bill.reminder_sent_at && (
            <span className="text-zinc-500"> · sent {new Date(bill.reminder_sent_at).toLocaleString()}</span>
          )}
        </p>
        <button
          type="button"
          data-testid="edit-bill-reminder"
          onClick={() => {
            setError(null);
            setEditing((v) => !v);
          }}
          className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50"
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      {editing && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
          <ReminderFields draft={draft} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
          <button
            type="button"
            data-testid="save-bill-reminder"
            disabled={saving}
            onClick={save}
            className="rounded bg-teal-700 px-3 py-1.5 text-xs text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save reminder"}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-600" data-testid="bill-reminder-error">
          {error}
        </p>
      )}
    </div>
  );
}
