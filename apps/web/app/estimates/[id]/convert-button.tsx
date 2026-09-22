"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function ConvertButton({ estimateId }: { estimateId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConvert() {
    // One-way action — the RPC rejects converting the same estimate twice — so confirm before
    // firing it, matching the mobile app's confirm dialog for the same button.
    if (!window.confirm("Convert to invoice? This creates a new invoice from this estimate and can't be undone.")) {
      return;
    }
    setConverting(true);
    setError(null);
    try {
      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
      const { data: invoiceId, error: rpcError } = await supabase.rpc("convert_estimate_to_invoice", {
        p_estimate_id: estimateId,
        p_invoice_number: invoiceNumber,
      });
      if (rpcError) throw rpcError;
      router.push(`/invoices/${invoiceId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "conversion failed");
      setConverting(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleConvert}
        disabled={converting}
        data-testid="convert-to-invoice-button"
        className="rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800 disabled:opacity-50"
      >
        {converting ? "Converting…" : "Convert to invoice"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
