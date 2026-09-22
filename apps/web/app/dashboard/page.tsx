import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmailDetectionBanner } from "../invoices/email-detection-banner";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Every stat here is real, computed from what's actually in the DB. same principle as the
  // Invoices page's own stats (no invented placeholder numbers on a dashboard).
  const [{ data: invoices }, { data: bills }, { data: estimates }, { data: clients }, { data: forwardingAddress }] =
    await Promise.all([
      supabase.from("invoices").select("id, status, total_cents"),
      supabase.from("bills").select("id, status, total_cents"),
      supabase.from("estimates").select("id"),
      supabase.from("clients").select("id"),
      supabase.from("email_forwarding_addresses").select("enabled, source_email").eq("user_id", user!.id).maybeSingle(),
    ]);

  const outstandingInvoices = (invoices ?? []).filter((i) => i.status === "draft" || i.status === "sent");
  const outstandingTotal = outstandingInvoices.reduce((sum, i) => sum + i.total_cents, 0);
  const unpaidBills = (bills ?? []).filter((b) => b.status === "unpaid");
  const unpaidTotal = unpaidBills.reduce((sum, b) => sum + b.total_cents, 0);
  const pendingReviewCount = (bills ?? []).filter((b) => b.status === "pending_review").length;

  const detectionEnabled = forwardingAddress?.enabled ?? false;

  const features = [
    {
      href: "/invoices",
      label: "Invoices",
      stat: `${(outstandingTotal / 100).toFixed(2)} outstanding`,
      sub: `${outstandingInvoices.length} invoice${outstandingInvoices.length === 1 ? "" : "s"}`,
      testId: "dashboard-invoices-tile",
    },
    {
      href: "/bills",
      label: "Bills",
      stat: `${(unpaidTotal / 100).toFixed(2)} unpaid`,
      sub:
        pendingReviewCount > 0
          ? `${unpaidBills.length} bill${unpaidBills.length === 1 ? "" : "s"} · ${pendingReviewCount} to review`
          : `${unpaidBills.length} bill${unpaidBills.length === 1 ? "" : "s"}`,
      testId: "dashboard-bills-tile",
    },
    {
      href: "/estimates",
      label: "Estimates",
      stat: `${(estimates ?? []).length}`,
      sub: "total",
      testId: "dashboard-estimates-tile",
    },
    {
      href: "/clients",
      label: "Clients",
      stat: `${(clients ?? []).length}`,
      sub: "total",
      testId: "dashboard-clients-tile",
    },
  ];

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="mb-1 text-sm text-zinc-500">Signed in as {user?.email}</p>
          <h1 className="text-2xl font-semibold text-zinc-900">Dashboard</h1>
        </div>
        <Link href="/settings" className="text-sm text-teal-700 underline" data-testid="settings-link">
          Business info
        </Link>
      </div>

      {/* Auto-detect & remind always sits at the very top, whether on or off. set-and-forget is
          the whole pitch, so its status should be the first thing a returning user sees, not
          something they have to go hunting for once they've turned it on. */}
      {detectionEnabled ? (
        <Link
          href="/connect-email"
          className="mb-6 flex items-center gap-4 rounded-xl border border-teal-100 bg-teal-50 p-4 hover:bg-teal-100"
          data-testid="email-detection-status-active"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-700 text-lg text-white">
            ✓
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-teal-900">Automatic bill &amp; invoice detection is on</p>
            <p className="text-xs text-teal-700">
              {forwardingAddress?.source_email ? `Connected: ${forwardingAddress.source_email}. ` : ""}
              {pendingReviewCount > 0
                ? `${pendingReviewCount} new bill${pendingReviewCount === 1 ? "" : "s"} waiting for your review.`
                : "You'll be reminded automatically before anything is due."}
            </p>
          </div>
          <span className="shrink-0 text-sm font-medium text-teal-700">Manage</span>
        </Link>
      ) : (
        <EmailDetectionBanner />
      )}

      <div className="mb-6">
        <p className="mb-2 text-sm font-semibold text-zinc-900">Create an invoice</p>
        <div className="grid grid-cols-3 gap-3">
          <Link
            href="/invoices/new"
            className="flex flex-col items-center gap-1 rounded-xl border border-zinc-200 p-3 text-center hover:border-teal-300 hover:bg-teal-50"
            data-testid="create-invoice-manual"
          >
            <span className="text-xl">📝</span>
            <span className="text-xs font-medium text-zinc-700">Manual entry</span>
          </Link>
          <Link
            href="/invoices/new?mode=scan"
            className="flex flex-col items-center gap-1 rounded-xl border border-zinc-200 p-3 text-center hover:border-teal-300 hover:bg-teal-50"
            data-testid="create-invoice-scan"
          >
            <span className="text-xl">📷</span>
            <span className="text-xs font-medium text-zinc-700">Scan a photo or PDF</span>
          </Link>
          <Link
            href="/invoices/new?mode=chat"
            className="flex flex-col items-center gap-1 rounded-xl border border-zinc-200 p-3 text-center hover:border-teal-300 hover:bg-teal-50"
            data-testid="create-invoice-chat"
          >
            <span className="text-xl">💬</span>
            <span className="text-xs font-medium text-zinc-700">Chat with AI</span>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {features.map((f) => (
          <Link
            key={f.href}
            href={f.href}
            className="rounded-xl border border-zinc-200 p-4 hover:border-teal-300 hover:bg-teal-50"
            data-testid={f.testId}
          >
            <p className="text-sm font-semibold text-zinc-900">{f.label}</p>
            <p className="mt-2 text-xl font-semibold text-zinc-900">{f.stat}</p>
            <p className="text-xs text-zinc-400">{f.sub}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
