"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type PendingBill = {
  id: string;
  vendor_name: string;
  total_cents: number;
  currency: string;
  due_date: string | null;
  reminder_days_before: number;
};

export function PendingReviewSection({ bills }: { bills: PendingBill[] }) {
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

  if (bills.length === 0) return null;

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
    router.refresh();
  }

  return (
    <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 p-4" data-testid="pending-review-section">
      <p className="mb-3 text-sm font-semibold text-sky-900">
        {bills.length} bill{bills.length === 1 ? "" : "s"} detected from email, review before they count as unpaid
      </p>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex flex-col gap-2">
        {bills.map((b) => (
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
          </div>
        ))}
      </div>
    </div>
  );
}
