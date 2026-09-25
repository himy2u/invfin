"use client";

import {
  REMINDER_UNITS,
  type ReminderDraft,
  maxExactLocalValue,
  minExactLocalValue,
} from "@/lib/reminder-draft";

/**
 * The offset/exact reminder control, in exactly one place.
 *
 * Lifted verbatim out of pending-review-section.tsx so the bill DETAIL page can edit an already
 * approved bill's reminder with the same control the review row uses, rather than growing a second
 * one that drifts. Owns no state: the draft and its setter belong to whoever renders it, because the
 * review table keys a draft per row while the detail page has exactly one.
 */
export function ReminderFields({
  draft,
  onChange,
  idPrefix,
}: {
  draft: ReminderDraft;
  onChange: (patch: Partial<ReminderDraft>) => void;
  /** Distinguishes the rendered controls when several sit on one page (one per review row). */
  idPrefix?: string;
}) {
  const isExact = draft.mode === "exact";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-600" data-testid="pending-review-reminder">
      <span>Remind me</span>
      {/* Two buttons rather than a <select>: the choice changes which fields appear next to it,
          and a segmented control makes that cause-and-effect visible at a glance. */}
      <div className="inline-flex overflow-hidden rounded border border-zinc-300">
        {(
          [
            ["offset", "Before due date"],
            ["exact", "Specific date"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            id={idPrefix ? `${idPrefix}-mode-${mode}` : undefined}
            data-testid={`reminder-mode-${mode}`}
            aria-pressed={draft.mode === mode}
            onClick={() => onChange({ mode })}
            className={
              draft.mode === mode
                ? "bg-teal-700 px-2 py-1 text-[11px] font-medium text-white"
                : "bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {isExact ? (
        // min/max are the browser's own half of the bounds check in reminderUpdatePayload. Without
        // them a six-digit year typed straight into the year field is accepted silently (a real
        // tester got 100120 in), and the only feedback came at submit time.
        <input
          type="datetime-local"
          value={draft.exactLocal}
          min={minExactLocalValue()}
          max={maxExactLocalValue()}
          data-testid="pending-review-reminder-at"
          onChange={(e) => onChange({ exactLocal: e.target.value })}
          className="rounded border border-zinc-300 px-1.5 py-1 text-xs"
        />
      ) : (
        <>
          <input
            type="number"
            min={0}
            value={draft.value}
            data-testid="pending-review-reminder-value"
            onChange={(e) => onChange({ value: e.target.value })}
            className="w-14 rounded border border-zinc-300 px-1.5 py-1 text-xs"
          />
          <select
            value={draft.unit}
            data-testid="pending-review-reminder-unit"
            onChange={(e) => onChange({ unit: e.target.value })}
            className="rounded border border-zinc-300 px-1.5 py-1 text-xs"
          >
            {REMINDER_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
          <span>before</span>
        </>
      )}
    </div>
  );
}
