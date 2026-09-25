"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  related_bill_id: string | null;
  read_at: string | null;
  created_at: string;
};

// Plain words for the `type` values the agent service actually writes. Shown as a small label rather
// than the raw value: "bill_extraction_failed" is a database enum-ish string, not something to put in
// front of a user.
const TYPE_LABELS: Record<string, string> = {
  bill_detected: "Bill detected",
  bill_reminder: "Reminder",
  bill_extraction_failed: "Needs your attention",
  gmail_confirmation: "Email setup",
};

/** "3 minutes ago" / "2 days ago", rendered on the client so it's relative to the READER's clock,
 * not the server's. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationsList({ initial }: { initial: NotificationRow[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    const readAt = new Date().toISOString();
    // Optimistic, then reconciled by the error branch. A bell badge that keeps a stale count after a
    // click reads as broken, and the update is a single trivial PATCH.
    const previous = rows;
    setRows((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, read_at: r.read_at ?? readAt } : r)));
    setError(null);
    const { error: updateError } = await supabase.from("notifications").update({ read_at: readAt }).in("id", ids);
    if (updateError) {
      setRows(previous);
      setError(updateError.message);
      return;
    }
    // Refreshes the server-rendered bell badge sitting in the header above this list.
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-zinc-500" data-testid="no-notifications">
        Nothing here yet. Detected bills and bill reminders show up on this page as they happen.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {unreadIds.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => markRead(unreadIds)}
            data-testid="mark-all-read"
            className="text-xs text-teal-700 underline"
          >
            Mark all as read ({unreadIds.length})
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((n) => (
          <li
            key={n.id}
            data-testid="notification-row"
            data-read={n.read_at ? "true" : "false"}
            className={`rounded-lg border p-3 ${
              n.read_at ? "border-zinc-200 bg-white" : "border-sky-200 bg-sky-50"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                  {!n.read_at && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-sky-600" aria-label="Unread" data-testid="unread-dot" />
                  )}
                  {n.title}
                </p>
                <p className="mt-0.5 break-words text-sm text-zinc-700">{n.body}</p>
                <p className="mt-1 text-xs text-zinc-400">
                  {TYPE_LABELS[n.type] ?? n.type} · {relativeTime(n.created_at)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {n.related_bill_id && (
                  <Link href={`/bills/${n.related_bill_id}`} className="text-xs text-teal-700 underline">
                    View bill
                  </Link>
                )}
                {!n.read_at && (
                  <button
                    type="button"
                    onClick={() => markRead([n.id])}
                    data-testid="mark-one-read"
                    className="text-xs text-zinc-500 underline hover:text-zinc-700"
                  >
                    Mark as read
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
