import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { NotificationBell } from "../notifications/notification-bell";
import { PendingReviewSection } from "./pending-review-section";

const STATUS_STYLES: Record<string, string> = {
  unpaid: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
};

// Deliberately drawn from the same vocabulary as STATUS_STYLES above rather than a new palette:
// amber already means "unpaid, needs attention" on this page, so "due soon" borrowing it reads as
// more of the same thing, and red is the escalation the page doesn't otherwise use. A third,
// unrelated hue here would just make the status pills harder to read.
const URGENCY_STYLES = {
  overdue: "bg-red-100 text-red-800",
  soon: "bg-amber-100 text-amber-800",
  later: "text-zinc-500",
} as const;

const DUE_SOON_DAYS = 7;

/** How urgent an unpaid bill's due date is, as of today. Null when there's nothing to be urgent
 * about (no due date, or the bill is already paid). */
function urgency(dueDate: string | null, status: string, today: Date): { label: string; className: string } | null {
  if (!dueDate || status !== "unpaid") return null;
  // Both sides compared as plain calendar dates at UTC midnight. A bill is due ON a date, not at an
  // instant, and mixing a date-only value with a local-time `now` makes "due today" flip to
  // "overdue" for anyone west of UTC.
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((due - startOfToday) / 86_400_000);

  if (days < 0) {
    return {
      label: days === -1 ? "Overdue by 1 day" : `Overdue by ${-days} days`,
      className: URGENCY_STYLES.overdue,
    };
  }
  if (days === 0) return { label: "Due today", className: URGENCY_STYLES.overdue };
  if (days <= DUE_SOON_DAYS) {
    return { label: days === 1 ? "Due tomorrow" : `Due in ${days} days`, className: URGENCY_STYLES.soon };
  }
  return { label: `Due ${dueDate}`, className: URGENCY_STYLES.later };
}

export default async function BillsPage() {
  const supabase = await createClient();
  // Soonest due first, not newest detected first. The list's whole job is "what do I have to pay
  // next", and created_at ordering answered a question nobody asked. Bills with no due date sort
  // last (nullsFirst: false), because there is nothing to act on by a deadline that doesn't exist, so they
  // belong below everything that does have one, not at the top where a NULLS FIRST default puts them.
  const { data: bills } = await supabase
    .from("bills")
    .select(
      "id, bill_number, status, total_cents, currency, vendor_name, due_date, reminder_mode, reminder_offset_value, reminder_offset_unit, reminder_at, duplicate_of_bill_id",
    )
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  // pending_review/dismissed are deliberately excluded here by filtering on the literal "unpaid"
  // status. see the migration comment on why review state reuses bill_status instead of a
  // parallel column: an AI-guessed, unconfirmed bill must never count toward "what you owe."
  const unpaid = (bills ?? []).filter((b) => b.status === "unpaid");
  const pendingReview = (bills ?? []).filter((b) => b.status === "pending_review");
  const visibleBills = (bills ?? []).filter((b) => b.status !== "pending_review" && b.status !== "dismissed");
  const today = new Date();

  // The duplicate flag names the bill it matched, and the bill it matched is this user's, so it's
  // already in the rows above, so no second query is needed to resolve the id to a human reference.
  const numberById = new Map((bills ?? []).map((b) => [b.id, b.bill_number]));
  const pendingWithDuplicates = pendingReview.map((b) => ({
    ...b,
    duplicate_of_bill_number: b.duplicate_of_bill_id ? (numberById.get(b.duplicate_of_bill_id) ?? null) : null,
  }));

  // Unpaid totals can span currencies (a detected bill carries whatever the vendor billed in), and
  // summing those into one figure would be a made-up number. One line per currency instead.
  const unpaidByCurrency = [...new Set(unpaid.map((b) => b.currency))].map((currency) => ({
    currency,
    cents: unpaid.filter((b) => b.currency === currency).reduce((sum, b) => sum + b.total_cents, 0),
  }));

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Bills</h1>
        <div className="flex items-center gap-4">
          <NotificationBell />
          <Link href="/dashboard" className="text-sm text-teal-700 underline">
            ← Dashboard
          </Link>
          <Link href="/invoices" className="text-sm text-teal-700 underline">
            Invoices
          </Link>
          <Link
            href="/bills/new"
            className="rounded bg-teal-700 px-3 py-1.5 text-sm text-white hover:bg-teal-800"
            data-testid="create-bill-button"
          >
            + New bill
          </Link>
        </div>
      </div>

      <PendingReviewSection bills={pendingWithDuplicates} />

      {unpaid.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="unpaid-summary">
          <p className="text-sm text-amber-800">
            <span className="font-semibold">
              {unpaidByCurrency.map((g) => formatMoney(g.cents, g.currency)).join(" + ")}
            </span>{" "}
            unpaid across {unpaid.length} bill{unpaid.length === 1 ? "" : "s"}
          </p>
        </div>
      )}

      {/* Both halves of this check matter. It used to test visibleBills alone, so a brand-new account
          whose only bills were awaiting review rendered "N bills detected from email" and "No bills
          yet" on the same screen. Two statements that can't both be true is how a user learns to
          distrust everything else on the page. */}
      {visibleBills.length === 0 && pendingReview.length === 0 && (
        <p className="text-sm text-zinc-500" data-testid="no-bills">
          No bills yet. A bill is money you owe a vendor (the mirror of an invoice, which is money
          owed to you).
        </p>
      )}

      <div className="flex flex-col gap-2">
        {visibleBills.map((b) => {
          const urgent = urgency(b.due_date, b.status, today);
          return (
            <Link
              key={b.id}
              href={`/bills/${b.id}`}
              className="flex items-center justify-between gap-3 rounded border border-zinc-200 p-3 hover:bg-zinc-50"
              data-testid="bill-row"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{b.vendor_name}</p>
                <p className="truncate text-xs text-zinc-500">
                  {b.bill_number}
                  {/* The due date lives in the urgency pill for anything unpaid. A paid bill gets no
                      pill, so it keeps the date here rather than losing it entirely. */}
                  {!urgent && b.due_date ? ` · due ${b.due_date}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {urgent && (
                  <span
                    className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${urgent.className}`}
                    data-testid="bill-urgency"
                  >
                    {urgent.label}
                  </span>
                )}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[b.status] ?? "bg-zinc-100 text-zinc-700"}`}
                >
                  {b.status}
                </span>
                <span className="whitespace-nowrap text-sm font-medium">{formatMoney(b.total_cents, b.currency)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
