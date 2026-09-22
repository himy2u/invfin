"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function MarkPaidButton({ billId }: { billId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMarkPaid() {
    // Paying a bill is the user's own record-keeping (we don't process the payment), but it's
    // still a one-way status change. confirm before flipping it, same principle as never
    // guessing/never silently rewriting a financial state.
    if (!window.confirm("Mark this bill as paid? This records that you've already paid the vendor.")) {
      return;
    }
    setMarking(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("mark_bill_paid", { p_bill_id: billId });
      if (rpcError) throw rpcError;
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to mark as paid");
    } finally {
      setMarking(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleMarkPaid}
        disabled={marking}
        data-testid="mark-bill-paid-button"
        className="rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800 disabled:opacity-50"
      >
        {marking ? "Marking…" : "Mark as paid"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
