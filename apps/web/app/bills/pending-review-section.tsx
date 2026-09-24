"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

type PendingBill = {
  id: string;
  vendor_name: string;
  total_cents: number;
  currency: string;
  due_date: string | null;
  reminder_days_before: number;
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
  const [reminderDays, setReminderDays] = useState<Record<string, number>>(
    Object.fromEntries(bills.map((b) => [b.id, b.reminder_days_before])),
  );

  if (bills.length === 0) return <>{emptyState}</>;

  async function approve(billId: string) {
    setBusyId(billId);
    setBusyAction("approve");
    setError(null);
    // Accepting a detected bill and confirming when to be reminded about it happen in one step .
    // save whatever reminder-days value is currently in the field before flipping it to unpaid,
    // so the user isn't confirming a value they never actually saw applied.
    const days = reminderDays[billId];
    const { error: updateError } = await supabase.from("bills").update({ reminder_days_before: days }).eq("id", billId);
    if (updateError) {
      setBusyId(null);
      setBusyAction(null);
      setError(updateError.message);
      return;
    }
    const { error: rpcError } = await supabase.rpc("approve_detected_bill", { p_bill_id: billId });
    setBusyId(null);
    setBusyAction(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChanged?.(billId);
    router.refresh();
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
    onChanged?.(billId);
    router.refresh();
  }

  const isTable = variant === "table";

  // Built once per row and placed by whichever variant is rendering, so the editable field and the
  // two one-way actions exist in exactly one place regardless of layout.
  function reminderInput(b: PendingBill) {
    return (
      <label className="flex items-center gap-1.5 text-xs text-zinc-600">
        Remind me
        <input
          type="number"
          min={0}
          max={30}
          value={reminderDays[b.id]}
          data-testid="pending-review-reminder-days"
          onChange={(e) => setReminderDays((prev) => ({ ...prev, [b.id]: Number(e.target.value) }))}
          className="w-14 rounded border border-zinc-300 px-1.5 py-1 text-xs"
        />
        days before
      </label>
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
          onClick={() => approve(b.id)}
          className="rounded bg-teal-700 px-3 py-1.5 text-xs text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {busyId === b.id && busyAction === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
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
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {isTable && (
        // Header row only, not a real <table>: the rows below have to collapse to a stacked card on
        // a narrow screen, which a table can't do. Hidden under sm for the same reason.
        <div className="hidden grid-cols-[2fr_1fr_1fr_auto] items-center gap-3 border-b border-zinc-200 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 sm:grid">
          <span>Vendor</span>
          <span>Amount</span>
          <span>Due</span>
          <span className="text-right">Remind me &amp; approve</span>
        </div>
      )}

      <div className={isTable ? "flex flex-col divide-y divide-zinc-100" : "flex flex-col gap-2"}>
        {bills.map((b) =>
          isTable ? (
            <div
              key={b.id}
              data-testid="pending-review-row"
              className="flex flex-col gap-2 px-3 py-3 sm:grid sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-center sm:gap-3"
            >
              <p className="text-sm font-medium text-zinc-900">{b.vendor_name}</p>
              <p className="text-sm text-zinc-700">
                {(b.total_cents / 100).toFixed(2)} {b.currency}
              </p>
              <p className="text-sm text-zinc-500">{b.due_date ?? "No due date"}</p>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {reminderInput(b)}
                {actions(b)}
              </div>
            </div>
          ) : (
            <div
              key={b.id}
              data-testid="pending-review-row"
              className="flex flex-col gap-2 rounded border border-sky-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium">{b.vendor_name}</p>
                <p className="text-xs text-zinc-500">
                  {(b.total_cents / 100).toFixed(2)} {b.currency} · due {b.due_date}
                </p>
              </div>
              <div className="flex items-center gap-3">
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
