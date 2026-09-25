"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/money";
import { type ReminderDraft, defaultExactLocalValue, reminderUpdatePayload } from "@/lib/reminder-draft";
import { ReminderFields } from "./reminder-fields";

type PendingBill = {
  id: string;
  vendor_name: string;
  total_cents: number;
  currency: string;
  due_date: string | null;
  reminder_mode: string;
  reminder_offset_value: number;
  reminder_offset_unit: string;
  reminder_at: string | null;
  bill_number?: string | null;
  duplicate_of_bill_id?: string | null;
  duplicate_of_bill_number?: string | null;
};

/**
 * Approve-or-edit-the-reminder for email-detected bills. Rendered in two places off the same
 * approve_detected_bill/dismiss_detected_bill RPCs — never forked:
 *
 *   "notice" (default, /bills) — a bordered call-out competing with the rest of the bills list,
 *       and invisible when there's nothing pending.
 *   "table" (/connect-email)  — the page's primary content, with column headers and a visible
 *       all-caught-up state, so the layout doesn't jump when the first bill lands.
 */
export function PendingReviewSection({
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
  /** Called with the bill that just left the queue. /bills re-renders from the server via
   * router.refresh() alone; the connect-email page holds its list in client state (it polls), so
   * it needs to be told rather than wait up to a poll interval for the row to disappear. */
  onChanged?: (billId: string) => void;
}) {
  const supabase = createClient();
  const router = useRouter();
  // busyAction tracks WHICH button is running, not just that the row is busy. a naive-user test
  // caught that a shared disabled-with-no-text-change state was invisible enough that clicking
  // Approve looked like it did nothing, leading to a double-click. Swapping the label (matching
  // this app's other one-way-action buttons, e.g. mark-paid-button.tsx) is a far more legible cue
  // than a subtle opacity dim on a row that's about to disappear anyway.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"approve" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sparse on purpose: a bill with no entry here has not been edited, and draftFor() derives its
  // draft from the bill's own stored columns instead. The previous version seeded this from `bills`
  // in a useState initializer, which ran exactly once, so a bill that arrived later (a poll picking
  // up new mail) had NO entry and `drafts[b.id].mode` threw, taking the whole review table down.
  const [drafts, setDrafts] = useState<Record<string, ReminderDraft>>({});
  // "saved" / "saving" per row. Reminder edits are now persisted as they're made rather than held
  // until Approve: a tester changed Days to Hours, the list re-rendered, and the edit vanished with
  // no warning. The structural cause is real and not fixable by holding state better. The
  // connect-email page swaps to a different JSX tree the moment its first bill is detected, which
  // unmounts this component and any state in it. Writing the value the user just chose is the only
  // version of this that cannot silently lose it.
  const [saveState, setSaveState] = useState<Record<string, "saving" | "saved">>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  function draftFor(b: PendingBill): ReminderDraft {
    return (
      drafts[b.id] ?? {
        mode: b.reminder_mode === "exact" ? "exact" : "offset",
        value: String(b.reminder_offset_value),
        unit: b.reminder_offset_unit,
        // The datetime-local input needs a local-time string, never an ISO/UTC one. Feeding it
        // a Z-suffixed value makes it render blank with no error.
        exactLocal: defaultExactLocalValue(b.reminder_at, b.due_date),
      }
    );
  }

  async function persist(billId: string, draft: ReminderDraft): Promise<boolean> {
    const result = reminderUpdatePayload(draft);
    if (!result.ok) {
      setError(result.error);
      setSaveState((prev) => {
        const next = { ...prev };
        delete next[billId];
        return next;
      });
      return false;
    }
    setError(null);
    const { error: updateError } = await supabase.from("bills").update(result.payload).eq("id", billId);
    if (updateError) {
      setError(updateError.message);
      setSaveState((prev) => {
        const next = { ...prev };
        delete next[billId];
        return next;
      });
      return false;
    }
    setSaveState((prev) => ({ ...prev, [billId]: "saved" }));
    return true;
  }

  function updateDraft(b: PendingBill, patch: Partial<ReminderDraft>) {
    const next = { ...draftFor(b), ...patch };
    setDrafts((prev) => ({ ...prev, [b.id]: next }));
    setSaveState((prev) => ({ ...prev, [b.id]: "saving" }));
    // Debounced, so typing "45" in the value field is one write rather than one per keystroke. The
    // delay is short enough that it lands well before a user can navigate away, and Approve saves
    // again unconditionally so the final value can never be the one that got debounced out.
    clearTimeout(saveTimers.current[b.id]);
    saveTimers.current[b.id] = setTimeout(() => {
      void persist(b.id, next);
    }, 600);
  }

  if (bills.length === 0) return <>{emptyState}</>;

  async function approve(b: PendingBill) {
    setBusyId(b.id);
    setBusyAction("approve");
    setError(null);
    // Accepting a detected bill and confirming when to be reminded about it happen in one step:
    // save whatever reminder timing is currently in the row before flipping it to unpaid, so the
    // user isn't confirming a value they never actually saw applied. This also flushes any autosave
    // still sitting in its debounce.
    clearTimeout(saveTimers.current[b.id]);
    const saved = await persist(b.id, draftFor(b));
    if (!saved) {
      setBusyId(null);
      setBusyAction(null);
      return;
    }
    const { error: rpcError } = await supabase.rpc("approve_detected_bill", { p_bill_id: b.id });
    setBusyId(null);
    setBusyAction(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChanged?.(b.id);
    router.refresh();
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
    onChanged?.(billId);
    router.refresh();
  }

  const isTable = variant === "table";

  // Built once per row and placed by whichever variant is rendering, so the editable fields and the
  // two one-way actions exist in exactly one place regardless of layout.
  //
  // Stays inline in the row rather than opening a modal, matching this table's "everything editable
  // is inline" rule: the whole point of the review queue is tick-and-approve without a detour.
  function reminderInput(b: PendingBill) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ReminderFields draft={draftFor(b)} onChange={(patch) => updateDraft(b, patch)} idPrefix={b.id} />
        {/* The save cue is deliberately quiet but present: an edit that persists invisibly is
            indistinguishable, to the user, from the silent revert this replaced. */}
        {saveState[b.id] && (
          <span
            className={saveState[b.id] === "saved" ? "text-[11px] text-teal-700" : "text-[11px] text-zinc-400"}
            data-testid="reminder-save-state"
          >
            {saveState[b.id] === "saved" ? "Saved" : "Saving…"}
          </span>
        )}
      </div>
    );
  }

  function actions(b: PendingBill) {
    return (
      <div className="flex items-center gap-2">
        <button
          data-testid="dismiss-detected-bill"
          disabled={busyId === b.id}
          onClick={() => dismiss(b.id)}
          className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
        >
          {busyId === b.id && busyAction === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
        <button
          data-testid="approve-detected-bill"
          disabled={busyId === b.id}
          onClick={() => approve(b)}
          className="rounded bg-teal-700 px-3 py-1.5 text-xs text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {busyId === b.id && busyAction === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
    );
  }

  // Due date renders at the same weight as the vendor name, not as muted metadata: it is the field
  // the whole reminder decision hangs on, so it sits immediately after the vendor in the table and
  // immediately under it in the stacked card.
  function dueDate(b: PendingBill) {
    return b.due_date ? (
      <span className="font-semibold text-zinc-900">{b.due_date}</span>
    ) : (
      <span className="text-zinc-400">No due date</span>
    );
  }

  // Flagged by create_detected_bill rather than silently dropped: the app's own setup instructions
  // tell users to forward their existing backlog manually once, which is exactly how the same bill
  // arrives twice with two different Postmark MessageIDs. Two indistinguishable rows is the bad
  // outcome; so is deleting a bill the user might genuinely owe twice. Naming the match lets them
  // decide, with Dismiss already sitting right there.
  // ONE grid template, shared by the header, the /connect-email table rows and the /bills notice
  // rows. Both testers reported the same misalignment on both pages, and the reason it was the same
  // bug twice is that the two variants were laying the same three fields out two different ways.
  //
  // minmax(0,2fr) rather than a bare 2fr: a bare fr track is minmax(auto, 2fr), so its min-content
  // width acts as a floor and a long vendor name shoves Due and Amount rightward on that row only.
  // A flex row with a flex-1 vendor has the mirror-image problem, since the columns then float on
  // the natural width of the amount. Fixed tracks plus `truncate` on the vendor is what actually
  // makes row N line up with row N+1.
  const COLUMNS = "sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-3";

  function dataRow(b: PendingBill) {
    return (
      <div className={`flex flex-col gap-0.5 ${COLUMNS}`}>
        <p className="truncate text-sm font-medium text-zinc-900" title={b.vendor_name}>
          {b.vendor_name}
        </p>
        <p className="whitespace-nowrap text-sm" data-testid="pending-review-due-date">
          {dueDate(b)}
        </p>
        <p className="whitespace-nowrap text-sm text-zinc-700 sm:text-right" data-testid="pending-review-amount">
          {formatMoney(b.total_cents, b.currency)}
        </p>
      </div>
    );
  }

  function duplicateFlag(b: PendingBill) {
    if (!b.duplicate_of_bill_id) return null;
    return (
      <p className="text-[11px] font-medium text-amber-700" data-testid="duplicate-bill-flag">
        ⚠ Possible duplicate of {b.duplicate_of_bill_number ?? "an existing bill"}: same vendor, amount and due date.
        Dismiss this one if it&apos;s the same bill.
      </p>
    );
  }

  return (
    <div
      className={isTable ? "mb-4" : "mb-6 rounded-lg border border-sky-200 bg-sky-50 p-4"}
      data-testid="pending-review-section"
    >
      {heading ?? (
        <p className="mb-3 text-sm font-semibold text-sky-900">
          {bills.length} bill{bills.length === 1 ? "" : "s"} detected from email, review before they count as unpaid
        </p>
      )}
      {error && <p className="mb-2 text-sm text-red-600" data-testid="pending-review-error">{error}</p>}

      {isTable && (
        // Header row only, not a real <table>: the rows below have to collapse to a stacked card on
        // a narrow screen, which a table can't do. Hidden under sm for the same reason. Uses the
        // same COLUMNS template as the rows, so the headings cannot drift off the data under them.
        <div className={`hidden border-b border-zinc-200 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 ${COLUMNS}`}>
          <span>Vendor</span>
          <span>Due</span>
          <span className="text-right">Amount</span>
        </div>
      )}

      <div className={isTable ? "flex flex-col divide-y divide-zinc-100" : "flex flex-col gap-2"}>
        {bills.map((b) =>
          isTable ? (
            // Two lines, not one: the reminder controls are a segmented toggle plus two fields, far
            // too wide to share a row with the data columns without squeezing the vendor and due
            // date into two-line wraps (which is exactly what a one-line version did). Still inline
            // in the row — no modal — just stacked beneath it.
            <div key={b.id} data-testid="pending-review-row" className="flex flex-col gap-2 px-3 py-3">
              {dataRow(b)}
              {duplicateFlag(b)}
              <div className="flex flex-wrap items-center justify-between gap-3">
                {reminderInput(b)}
                {actions(b)}
              </div>
            </div>
          ) : (
            // Stacked, not a side-by-side row. The data and the reminder controls competing for one
            // horizontal line is what produced the misalignment both testers reported: the controls
            // are a segmented toggle plus two fields, so whatever is left over for the vendor name
            // collapses and wraps a word per line. Same two-line shape, and the same COLUMNS grid,
            // that the table variant uses.
            <div
              key={b.id}
              data-testid="pending-review-row"
              className="flex flex-col gap-2 rounded border border-sky-200 bg-white p-3"
            >
              {dataRow(b)}
              {duplicateFlag(b)}
              <div className="flex flex-wrap items-center justify-between gap-3">
                {reminderInput(b)}
                {actions(b)}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
