import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

/**
 * The entry point to the in-app notification channel, which until now had none.
 *
 * "In-app" is on by default, /send-test-reminder reports it `delivered: true`, and real
 * `notifications` rows have been accumulating for every detected bill and every reminder. But nothing
 * in either app read that table for a general user (the one query that existed is scoped to
 * `type = 'gmail_confirmation'` inside the connect-email wizard), so a reminder "delivered" in-app
 * went nowhere a user could ever look. Reporting delivery on a channel with no surface is the exact
 * claim this product exists to not make.
 *
 * A server component doing a HEAD count rather than a client component polling: the count only has to
 * be right when a page loads, and every page that renders this is already server-rendered per request.
 */
export async function NotificationBell() {
  const supabase = await createClient();
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  const unread = count ?? 0;

  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      className="relative inline-flex shrink-0 items-center rounded p-1 text-lg leading-none hover:bg-zinc-100"
      data-testid="notification-bell"
    >
      <span aria-hidden>🔔</span>
      {unread > 0 && (
        <span
          className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
          data-testid="notification-badge"
        >
          {/* Capped rather than rendered literally. A three-digit count would blow the badge out of
              the header, and "what's the exact number of unread notifications" is not a question
              anyone is asking of a bell. */}
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
