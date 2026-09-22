"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { buildExportPayload } from "@/lib/invoice-export";

export function SendInvoiceButton({
  invoiceId,
  alreadySent,
  hasClientEmail,
}: {
  invoiceId: string;
  alreadySent: boolean;
  hasClientEmail: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSend() {
    setSending(true);
    setError(null);

    try {
      // Fetched via this platform's own authenticated (RLS-scoped) Supabase client — the same
      // logic mobile uses — rather than a Next.js API route, since mobile has no way to share a
      // browser session cookie with one.
      const exportPayload = await buildExportPayload(supabase, invoiceId);
      const clientEmail = exportPayload.client.email;
      if (!clientEmail) throw new Error("this client has no email on file");

      const agentUrl = process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/send-invoice-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: clientEmail,
          invoice_number: exportPayload.invoice_number,
          total_formatted: (exportPayload.total_cents / 100).toFixed(2),
          currency: exportPayload.currency,
          export: exportPayload,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? "send failed");
      }

      // Status only flips to "sent" after the send call above actually succeeded — never mark it
      // sent speculatively (same principle as never marking "paid" without a webhook confirming it).
      const { error: updateError } = await supabase
        .from("invoices")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", invoiceId);
      if (updateError) throw new Error("email sent, but failed to update status, refresh to check");

      setSent(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setSending(false);
    }
  }

  if (!hasClientEmail) {
    return <p className="text-sm text-amber-700">This client has no email on file, can&apos;t send.</p>;
  }

  if (alreadySent || sent) {
    return (
      <p className="text-sm text-teal-700" data-testid="send-confirmation">
        ✓ Sent
      </p>
    );
  }

  return (
    <div>
      <button
        onClick={handleSend}
        disabled={sending}
        data-testid="send-invoice-button"
        className="rounded bg-teal-700 px-4 py-2 text-sm text-white hover:bg-teal-800 disabled:opacity-50"
      >
        {sending ? "Sending…" : "Send invoice"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
