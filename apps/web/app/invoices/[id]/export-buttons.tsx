"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { buildExportPayload } from "@/lib/invoice-export";

export function ExportButtons({ invoiceId }: { invoiceId: string }) {
  const supabase = createClient();
  const [downloading, setDownloading] = useState<"pdf" | "csv" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(format: "pdf" | "csv") {
    setDownloading(format);
    setError(null);
    try {
      const payload = await buildExportPayload(supabase, invoiceId);
      const agentUrl = process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/generate-invoice-${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${format} export failed`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${payload.invoice_number}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "download failed");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="mb-4 flex gap-2">
      <button
        onClick={() => handleDownload("pdf")}
        disabled={downloading !== null}
        data-testid="download-pdf-button"
        className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {downloading === "pdf" ? "…" : "Download PDF"}
      </button>
      <button
        onClick={() => handleDownload("csv")}
        disabled={downloading !== null}
        data-testid="download-csv-button"
        className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {downloading === "csv" ? "…" : "Download CSV"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
