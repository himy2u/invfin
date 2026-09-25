import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { NotificationsList, type NotificationRow } from "./notifications-list";

// A cap, not pagination. The table only ever grows by one row per detected bill and one per reminder,
// so a couple of hundred covers a real account's whole history; adding paging for a volume nobody has
// would be building for a problem that doesn't exist yet.
const MAX_NOTIFICATIONS = 200;

export default async function NotificationsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, related_bill_id, read_at, created_at")
    .order("created_at", { ascending: false })
    // Tiebreaker, not decoration: notifications written in one batch can share a created_at to the
    // microsecond, and Postgres may return equal-keyed rows in any order, so without this the list
    // can silently reshuffle between two loads of the same data.
    .order("id", { ascending: false })
    .limit(MAX_NOTIFICATIONS);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <div className="flex gap-4">
          <Link href="/dashboard" className="text-sm text-teal-700 underline">
            ← Dashboard
          </Link>
          <Link href="/bills" className="text-sm text-teal-700 underline">
            Bills
          </Link>
        </div>
      </div>

      <NotificationsList initial={(data ?? []) as NotificationRow[]} />
    </main>
  );
}
