import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius } from "../lib/theme";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  related_bill_id: string | null;
  read_at: string | null;
  created_at: string;
};

// A cap, not pagination. One row per detected bill and one per reminder, so a couple of hundred covers
// a real account's whole history.
const MAX_NOTIFICATIONS = 200;

const TYPE_LABELS: Record<string, string> = {
  bill_detected: "Bill detected",
  bill_reminder: "Reminder",
  bill_extraction_failed: "Needs your attention",
  gmail_confirmation: "Email setup",
};

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

/**
 * The in-app notification channel's surface on mobile, mirroring apps/web/app/notifications/page.tsx.
 *
 * "In-app" has been on by default and writing real `notifications` rows for every detected bill and
 * every reminder, with nothing anywhere that displayed them. See the note on the web NotificationBell
 * for why claiming delivery to a channel with no surface is the specific thing this product exists not
 * to do.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("notifications")
      .select("id, type, title, body, related_bill_id, read_at, created_at")
      .order("created_at", { ascending: false })
      // Tiebreaker, matching web: rows sharing a created_at would otherwise come back in any order.
      .order("id", { ascending: false })
      .limit(MAX_NOTIFICATIONS)
      .then(({ data }) => {
        if (cancelled) return;
        setRows((data as NotificationRow[]) ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(load);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    const readAt = new Date().toISOString();
    const previous = rows;
    setRows((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, read_at: r.read_at ?? readAt } : r)));
    setError(null);
    const { error: updateError } = await supabase.from("notifications").update({ read_at: readAt }).in("id", ids);
    if (updateError) {
      setRows(previous);
      setError(updateError.message);
    }
  }

  const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id);

  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted} testID="no-notifications">
          Nothing here yet. Detected bills and bill reminders show up on this screen as they happen.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="notifications-screen">
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          unreadIds.length > 0 ? (
            <Pressable onPress={() => markRead(unreadIds)} testID="mark-all-read" style={styles.markAll}>
              <Text style={styles.markAllText}>Mark all as read ({unreadIds.length})</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <View
            style={[styles.card, item.read_at ? styles.cardRead : styles.cardUnread]}
            testID="notification-row"
            accessibilityState={{ selected: !item.read_at }}
          >
            <View style={styles.cardTop}>
              <View style={{ flex: 1 }}>
                <View style={styles.titleRow}>
                  {!item.read_at && <View style={styles.unreadDot} testID="unread-dot" />}
                  <Text style={styles.title}>{item.title}</Text>
                </View>
                <Text style={styles.body}>{item.body}</Text>
                <Text style={styles.meta}>
                  {TYPE_LABELS[item.type] ?? item.type} · {relativeTime(item.created_at)}
                </Text>
              </View>
            </View>
            <View style={styles.actions}>
              {item.related_bill_id && (
                <Pressable onPress={() => router.push(`/bills/${item.related_bill_id}`)}>
                  <Text style={styles.link}>View bill</Text>
                </Pressable>
              )}
              {!item.read_at && (
                <Pressable onPress={() => markRead([item.id])} testID="mark-one-read">
                  <Text style={styles.muted}>Mark as read</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl },
  muted: { fontSize: 12, color: colors.textMuted },
  error: { fontSize: 12, color: colors.danger, fontWeight: "600", marginBottom: spacing.sm },
  markAll: { alignSelf: "flex-end", marginBottom: spacing.sm },
  markAllText: { fontSize: 12, color: colors.brand, fontWeight: "600" },
  card: { borderWidth: 1, borderRadius: radius.sm, padding: spacing.sm, marginBottom: spacing.sm, gap: 6 },
  cardRead: { borderColor: colors.border, backgroundColor: colors.surface },
  cardUnread: { borderColor: "#bae6fd", backgroundColor: "#f0f9ff" },
  cardTop: { flexDirection: "row", gap: spacing.sm },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#0284c7" },
  title: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  body: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  meta: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.md },
  link: { fontSize: 12, color: colors.brand, fontWeight: "600" },
});
